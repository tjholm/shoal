---
name: flatten
description: "Find and fix deeply nested code using extraction (pull logic into functions) and inversion (guard clauses, early returns). Targets functions exceeding 3 levels of nesting."
user-invocable: true
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# Flatten

When invoked, scan the specified file or directory for functions with deep nesting. Any code with a depth greater than 3 levels is excessive. Report findings with file paths and line numbers, then refactor each offending function using **extraction** and **inversion** to reduce nesting.

If the user has not specified a scope (file or directory), ask them which file or directory to focus on before proceeding.

## Core Rules

1. **Never nest more than 3 levels deep.** Count from the function body as level 1. An `if` inside the function body is level 2. A loop inside that `if` is level 3. Anything deeper must be refactored.

2. **Apply inversion first** -- it is the simpler technique. Flip conditions to put the failure or edge case first. Return, throw, or `continue` early. The happy path flows downward at the shallowest nesting depth.

3. **Apply extraction second** -- when inversion alone is not enough. Pull inner blocks (loop bodies, switch cases, deeply nested branches) into their own well-named functions. Each extracted function should have a single clear responsibility.

4. **Stack all validations at the top of a function as guard clauses.** Each guard checks one precondition and exits early if it fails. The core logic below the guards runs only when all preconditions are met.

5. **Extracted functions should be pure when possible** -- take inputs as parameters and return outputs. Avoid modifying external state. This makes the functions easier to understand and test.

6. **Add a doc comment to every extracted function.** The doc comment should be concise and describe *what* the function does and *what* it returns -- not *how* it works internally. Describe the interface, not the implementation. Use the language's standard doc format (JSDoc, pydoc, JavaDoc, `///` in Rust/C#, etc.).

7. **After refactoring, the top-level function should read like a table of contents** -- a sequence of named steps that describe what happens at a high level, with details pushed into sub-functions.

8. **Preserve existing behavior.** Do not change what the code does, only how it is structured. Run existing tests after refactoring to verify correctness.

## Procedure

1. **Find candidates.** Read the files in the user's specified scope. Identify functions where nesting exceeds 3 levels. Report each one with its file path, line number, and current max nesting depth.

2. **Assess each function.** Determine whether inversion, extraction, or both are needed:
   - If the deep nesting is caused by validation checks wrapping the main logic → **inversion** (guard clauses).
   - If the deep nesting is caused by large blocks inside loops or conditionals → **extraction** (pull into sub-functions).
   - If both → apply inversion first to flatten the outer structure, then extract remaining deep blocks.

3. **Refactor.** Apply the transformations. Name extracted functions to describe *what* they do, not *how*. Keep extracted functions in the same file/class as their caller unless they are independently reusable.

4. **Present changes.** Show the user what was changed and why, with a brief explanation for each function.

## Adapt to the User's Language

Apply these techniques using the idioms of whatever language the codebase uses. Guard clauses work in every language. Extraction means functions in procedural code, methods in OOP, or named closures in functional code.

---

## Examples

All examples below are original illustrations of the techniques. Adapt the style to match the user's actual codebase.

### Example A: Guard Clause Inversion (Simple)

A function that validates inputs and processes a payment, nested 4 levels deep:

**Before:**

```python
def process_payment(account, amount, currency):
    if account is not None:
        if amount > 0:
            if currency in SUPPORTED_CURRENCIES:
                rate = get_exchange_rate(currency)
                converted = amount * rate
                account.balance -= converted
                ledger.record(account.id, converted, currency)
                return Receipt(account.id, converted)
            else:
                raise ValueError(f"Unsupported currency: {currency}")
        else:
            raise ValueError("Amount must be positive")
    else:
        raise ValueError("Account is required")
```

The actual work (4 lines) is buried under 3 levels of validation. A reader must hold all three conditions in their head while reading the core logic.

**After:**

```python
def process_payment(account, amount, currency):
    if account is None:
        raise ValueError("Account is required")
    if amount <= 0:
        raise ValueError("Amount must be positive")
    if currency not in SUPPORTED_CURRENCIES:
        raise ValueError(f"Unsupported currency: {currency}")

    rate = get_exchange_rate(currency)
    converted = amount * rate
    account.balance -= converted
    ledger.record(account.id, converted, currency)
    return Receipt(account.id, converted)
```

Three guard clauses at the top declare the function's requirements. The core logic flows at the shallowest level. A reader can mentally discard the guards and focus on the payment logic.

---

### Example B: Loop Body Extraction

A function that processes orders inside a loop, with nested conditions for discounts and tax:

**Before:**

```typescript
function generateInvoice(orders: Order[]): Invoice {
    const lineItems: LineItem[] = [];

    for (const order of orders) {
        if (order.status === "confirmed") {
            let subtotal = 0;
            for (const item of order.items) {
                let price = item.unitPrice * item.quantity;
                if (item.category === "electronics" && item.quantity >= 10) {
                    price *= 0.9; // bulk discount
                } else if (item.category === "perishable") {
                    if (item.daysUntilExpiry < 3) {
                        price *= 0.5; // clearance
                    }
                }
                subtotal += price;
            }
            const tax = subtotal * order.taxRate;
            lineItems.push({
                orderId: order.id,
                subtotal,
                tax,
                total: subtotal + tax,
            });
        }
    }

    return { lineItems, grandTotal: lineItems.reduce((s, li) => s + li.total, 0) };
}
```

The innermost pricing logic is 5 levels deep. The function mixes iteration, filtering, pricing, discounting, and invoice assembly.

**After:**

```typescript
/** Returns the effective price for an order item, applying bulk or clearance discounts where eligible. */
function calculateItemPrice(item: OrderItem): number {
    const basePrice = item.unitPrice * item.quantity;

    if (item.category === "electronics" && item.quantity >= 10) {
        return basePrice * 0.9;
    }
    if (item.category === "perishable" && item.daysUntilExpiry < 3) {
        return basePrice * 0.5;
    }

    return basePrice;
}

/** Builds an invoice line item for a confirmed order, including subtotal, tax, and total. */
function buildLineItem(order: Order): LineItem {
    const subtotal = order.items.reduce(
        (sum, item) => sum + calculateItemPrice(item), 0
    );
    const tax = subtotal * order.taxRate;

    return { orderId: order.id, subtotal, tax, total: subtotal + tax };
}

/** Generates an invoice from confirmed orders, with line items and a grand total. */
function generateInvoice(orders: Order[]): Invoice {
    const lineItems = orders
        .filter(order => order.status === "confirmed")
        .map(buildLineItem);

    return { lineItems, grandTotal: lineItems.reduce((s, li) => s + li.total, 0) };
}
```

Each function has one job: `calculateItemPrice` handles discount rules, `buildLineItem` assembles a line item, and `generateInvoice` orchestrates the pipeline. Max nesting is 2. The top-level function reads as a clear sequence of steps.

---

### Example C: Combined Extraction + Inversion (Larger)

A warehouse inventory sync function that is 6 levels deep:

**Before:**

```java
public void syncInventory(List<Warehouse> warehouses) {
    for (Warehouse warehouse : warehouses) {
        if (warehouse.isActive()) {
            List<Product> products = warehouse.getProducts();
            for (Product product : products) {
                if (product.getStockLevel() < product.getReorderThreshold()) {
                    Supplier supplier = supplierRegistry.getSupplier(product.getSupplierId());
                    if (supplier != null && supplier.isAvailable()) {
                        try {
                            int reorderQty = product.getReorderThreshold() - product.getStockLevel();
                            PurchaseOrder po = supplier.placeOrder(product.getSku(), reorderQty);
                            if (po.isConfirmed()) {
                                product.setPendingRestock(reorderQty);
                                auditLog.record("reorder_placed", product.getSku(), reorderQty);
                            } else {
                                auditLog.record("reorder_rejected", product.getSku(), po.getRejectionReason());
                            }
                        } catch (SupplierException e) {
                            auditLog.record("supplier_error", product.getSku(), e.getMessage());
                            alertService.notify("Supplier error for " + product.getSku());
                        }
                    } else {
                        auditLog.record("supplier_unavailable", product.getSupplierId());
                    }
                }
            }
        }
    }
}
```

This single method handles iteration, filtering, supplier lookup, ordering, confirmation handling, error handling, and audit logging -- all nested 6+ levels deep.

**After:**

First, apply inversion to eliminate the wrapping conditions:

```java
public void syncInventory(List<Warehouse> warehouses) {
    for (Warehouse warehouse : warehouses) {
        if (!warehouse.isActive()) {
            continue;
        }
        for (Product product : warehouse.getProducts()) {
            reorderIfNeeded(product);
        }
    }
}
```

Then extract the reorder logic:

```java
/** Checks if a product's stock is below its reorder threshold and places a reorder if a supplier is available. */
private void reorderIfNeeded(Product product) {
    if (product.getStockLevel() >= product.getReorderThreshold()) {
        return;
    }

    Supplier supplier = supplierRegistry.getSupplier(product.getSupplierId());
    if (supplier == null || !supplier.isAvailable()) {
        auditLog.record("supplier_unavailable", product.getSupplierId());
        return;
    }

    placeReorder(product, supplier);
}

/** Places a purchase order with the supplier to restock the product up to its reorder threshold. */
private void placeReorder(Product product, Supplier supplier) {
    int reorderQty = product.getReorderThreshold() - product.getStockLevel();

    try {
        PurchaseOrder po = supplier.placeOrder(product.getSku(), reorderQty);
        handleOrderResult(product, po, reorderQty);
    } catch (SupplierException e) {
        auditLog.record("supplier_error", product.getSku(), e.getMessage());
        alertService.notify("Supplier error for " + product.getSku());
    }
}

/** Records the outcome of a purchase order -- updates pending restock on confirmation, or logs the rejection reason. */
private void handleOrderResult(Product product, PurchaseOrder po, int quantity) {
    if (po.isConfirmed()) {
        product.setPendingRestock(quantity);
        auditLog.record("reorder_placed", product.getSku(), quantity);
    } else {
        auditLog.record("reorder_rejected", product.getSku(), po.getRejectionReason());
    }
}
```

The top-level `syncInventory` reads as a clear description: for each active warehouse, check each product and reorder if needed. Each sub-function handles one concern. Max nesting depth is 2. The guard clauses in `reorderIfNeeded` make the preconditions immediately visible.
