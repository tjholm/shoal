# Examples

Worked before/after examples for each category of refactor. Cross-references rules in [NAMING.md](NAMING.md) and [COMMENTS.md](COMMENTS.md).

## Example A — Magic numbers and naming

A function with cryptic variable names and unexplained numeric literals.

**Before:**

```python
def proc(o):
    if o.s == 3:
        t = o.d * 86400
        if t > 604800:
            o.s = 4
            notify(o.u, 1)
        else:
            sched(o.id, t)
    elif o.s == 7:
        cleanup(o.id)
```

A reader must guess what `s`, `d`, `t`, `3`, `86400`, `604800`, `4`, `7`, and `1` mean. The function name `proc` tells you nothing.

**After:**

```python
SECONDS_PER_DAY = 86400
MAX_SCHEDULE_WINDOW_SECONDS = 7 * SECONDS_PER_DAY

ORDER_SHIPPED = 3
ORDER_EXPIRED = 4
ORDER_CANCELLED = 7

NOTIFICATION_DELIVERY_REMINDER = 1


def schedule_or_expire_order(order):
    if order.status == ORDER_SHIPPED:
        delivery_window_seconds = order.estimated_days * SECONDS_PER_DAY
        if delivery_window_seconds > MAX_SCHEDULE_WINDOW_SECONDS:
            order.status = ORDER_EXPIRED
            notify(order.user_id, NOTIFICATION_DELIVERY_REMINDER)
        else:
            schedule_followup(order.id, delivery_window_seconds)

    elif order.status == ORDER_CANCELLED:
        cleanup_order(order.id)
```

Every value has a name that explains its purpose. The function name describes what it does. A reader does not need any external context to understand this code.

*Rules applied:* NAMING #1, #2, #4; COMMENTS #1.

---

## Example B — Comments replaced by named variables

A complex condition with a long comment explaining the logic.

**Before:**

```typescript
// Apply a discount if the customer has been a member for more than 2 years
// and has made at least 5 purchases this quarter, OR if they have a corporate
// account with an active discount agreement that hasn't expired
if (
    (customer.memberSince < Date.now() - 63072000000 &&
     customer.purchasesThisQuarter >= 5) ||
    (customer.accountType === "corporate" &&
     customer.discountAgreement &&
     customer.discountAgreement.expiresAt > Date.now())
) {
    applyDiscount(order, customer.discountRate);
}
```

The comment is needed because the condition is unreadable. It also goes stale the moment someone changes the condition without updating it.

**After:**

```typescript
const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const LOYALTY_PURCHASE_THRESHOLD = 5;

const hasLoyaltyDiscount =
    customer.memberSince < Date.now() - TWO_YEARS_MS &&
    customer.purchasesThisQuarter >= LOYALTY_PURCHASE_THRESHOLD;

const hasCorporateDiscount =
    customer.accountType === "corporate" &&
    customer.discountAgreement?.expiresAt > Date.now();

if (hasLoyaltyDiscount || hasCorporateDiscount) {
    applyDiscount(order, customer.discountRate);
}
```

The `if` reads like the original comment: "has loyalty discount or has corporate discount." The two named booleans carry the meaning; the constants pin the magic numbers. Change the loyalty threshold and there is no stale comment to update.

*Rules applied:* COMMENTS #1, #2.

---

## Example C — Utils class decomposition

A blog codebase has accumulated an `ArticleUtils` class. At a glance every function looks defensible — most of them really do touch articles.

**Before:**

```typescript
class ArticleUtils {
    static excerpt(article: Article, maxChars: number): string { /* ... */ }
    static readingTimeMinutes(article: Article): number { /* ... */ }
    static filterPublished(articles: Article[]): Article[] { /* ... */ }
    static sortByPublishDate(articles: Article[]): Article[] { /* ... */ }
    static escapeHtml(raw: string): string { /* ... */ }
    static parseQueryParam(name: string): string | null { /* ... */ }
}

// Usage scattered across the codebase:
const preview = ArticleUtils.excerpt(article, 200);
const minutes = ArticleUtils.readingTimeMinutes(article);
const live = ArticleUtils.filterPublished(allArticles);
const recent = ArticleUtils.sortByPublishDate(live);
const safeBody = ArticleUtils.escapeHtml(comment.body);
const tag = ArticleUtils.parseQueryParam("tag");
```

"They all relate to articles" falls apart the moment you read the list. `escapeHtml` is generic string sanitization — used on comments, search snippets, anything. `parseQueryParam` reads from the URL. Neither has anything to do with articles; they got tossed in because nobody had a better home for them. Even the four that do touch articles split into distinct ideas — facts about a single article versus operations over a collection.

**After:**

```typescript
class Article {
    excerpt(maxChars: number): string { /* ... */ }
    readingTimeMinutes(): number { /* ... */ }
}

class Articles {
    constructor(readonly all: Article[]) {}

    published(): Articles { /* ... */ }
    sortedByPublishDate(): Articles { /* ... */ }
}

// html.ts
export function escapeHtml(raw: string): string { /* ... */ }

// queryParams.ts
export function parseQueryParam(name: string): string | null { /* ... */ }
```

```typescript
const preview = article.excerpt(200);
const minutes = article.readingTimeMinutes();
const recent = new Articles(allArticles).published().sortedByPublishDate();
const safeBody = escapeHtml(comment.body);
const tag = parseQueryParam("tag");
```

Each piece lives where it makes sense. `Article` owns facts about a single article. `Articles` owns operations over a collection — and chains naturally. `escapeHtml` and `parseQueryParam` get their own modules; they were never about articles, they just had no obvious home before. There is no `Utils` catch-all.

*Rules applied:* NAMING #7.

---

## Example D — Types replacing comments

Functions that use comments to document what their types cannot express.

**Before:**

```java
public class UserRepository {
    /**
     * Finds a user by email.
     * @return the User, or null if no user exists with that email
     */
    public User findByEmail(String email) {
        // ...
    }

    /**
     * Calculates estimated delivery time.
     * @param weight package weight in grams
     * @param distance distance to destination in kilometers
     * @return estimated delivery time in hours, or -1 if route is unavailable
     */
    public int estimateDeliveryTime(int weight, int distance) {
        // ...
    }
}
```

The comments are load-bearing. Without them, a caller does not know that `findByEmail` might return `null` or that `-1` means "unavailable." But the comments can become stale if someone changes the behavior.

**After:**

```java
public class UserRepository {
    public Optional<User> findByEmail(String email) {
        // ...
    }

    public Optional<Duration> estimateDeliveryTime(Weight weight, Distance distance) {
        // ...
    }
}
```

`Optional<User>` makes it impossible to forget the null case — the compiler forces the caller to handle it. `Optional<Duration>` replaces the magic `-1` sentinel value. `Weight` and `Distance` are typed values that carry their units, eliminating the "in grams" and "in kilometers" comments. The type signatures now convey everything the comments used to say, and the compiler enforces correctness.

*Rules applied:* NAMING #4; COMMENTS #3, #10.

---

## Example E — Remove inline clutter, add doc comments

A file with many inline comments explaining obvious code, but no doc comments on any of the functions.

**Before:**

```typescript
function calculateShippingCost(items, destination) {
    // Calculate the total weight
    let totalWeight = 0;
    for (const item of items) {
        totalWeight += item.weight; // add weight
    }

    // Get the rate for this destination
    const rate = getRate(destination);

    // Apply the rate to get the cost
    const cost = totalWeight * rate;

    // Free shipping for orders over 50
    if (cost > 50) {
        return 0;
    }

    // Return the cost
    return cost;
}

function getRate(destination) {
    // Check if it's domestic
    if (destination.country === "US") {
        return 0.5; // domestic rate
    }
    // International rate
    return 2.0;
}

function formatForDisplay(cost) {
    // Format as dollars
    return "$" + cost.toFixed(2);
}
```

Every inline comment either restates the code or explains a magic number. None of the functions have doc comments, so a caller must read the entire body to understand what each function does.

**After:**

```typescript
const FREE_SHIPPING_THRESHOLD = 50;
const DOMESTIC_RATE_PER_KG = 0.5;
const INTERNATIONAL_RATE_PER_KG = 2.0;

/** Calculates shipping cost for a set of items to a destination. Returns 0 if the order qualifies for free shipping. */
function calculateShippingCost(items: CartItem[], destination: Address): number {
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    const cost = totalWeight * getShippingRate(destination);

    return cost > FREE_SHIPPING_THRESHOLD ? 0 : cost;
}

/** Returns the per-kilogram shipping rate for a destination based on whether it is domestic or international. */
function getShippingRate(destination: Address): number {
    if (destination.country === "US") {
        return DOMESTIC_RATE_PER_KG;
    }
    return INTERNATIONAL_RATE_PER_KG;
}

/** Formats a cost as a USD dollar string (e.g. "$12.50"). */
function formatForDisplay(cost: number): string {
    return "$" + cost.toFixed(2);
}
```

Every inline comment is gone — the code is clear without them. Named constants replace magic numbers. Every function now has a concise doc comment that tells callers what it does and what it returns, without describing the implementation. A developer using these functions can read the doc comment and signature without ever looking at the body.

*Rules applied:* COMMENTS #1, #4, #6, #10.
