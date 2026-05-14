---
name: simplify-abstractions
description: "Evaluate abstractions and inheritance for over-coupling. Simplify by removing premature abstractions, replacing inheritance with composition, and using interfaces only when justified."
user-invocable: true
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# Simplify Abstractions

When invoked, review the specified code for over-abstraction, premature interfaces, and problematic inheritance hierarchies. Identify coupling introduced by abstractions that do not earn their keep. Recommend and apply simplifications: remove unjustified abstractions, replace inheritance with composition, and introduce interfaces only where the coupling cost is justified by real value.

If the user has not specified a scope (file or directory), ask them which file or directory to focus on before proceeding.

## Core Rules: Abstraction Tradeoffs

1. **Every abstraction adds coupling.** For every bit of abstraction you add, you increase coupling equally. The coupling cost must be justified by concrete value, not theoretical future value.

2. **Do not abstract just because code looks similar.** Two classes that happen to share a field assignment or a method name are not necessarily candidates for a shared parent or interface. Similarity alone is insufficient justification.

3. **An abstraction is NOT worth it when:**
   - There are only 1-2 implementations.
   - The shared code is trivial (assigning a variable, calling a single method).
   - The if-statement or switch selecting between implementations is simple and localized to one place.
   - The coupling constrains future changes with no offsetting benefit.

4. **An abstraction IS worth it when:**
   - There are 3 or more implementations (or strong evidence a third is imminent).
   - You need to defer or repeat usage -- e.g., a scheduler, retry mechanism, or pipeline that invokes the abstraction at a different time or place from where the decision was made.
   - The decision of *which* implementation to use and the *usage* of that implementation are far apart in the code (different modules, different request phases, different lifecycle stages).

5. **A little code duplication is preferable to premature coupling.** Duplicated code is independent -- you can change one copy without risking the other. Coupled code must change together, and the coupling may constrain changes you haven't anticipated yet.

## Core Rules: Inheritance vs. Composition

6. **Inheritance couples the child to the parent's entire structure.** Not just the methods you want to reuse, but all the parent's fields, lifecycle, and assumptions. The child inherits everything, whether it makes sense or not.

7. **Inheritance forces children to implement or inherit methods that may be irrelevant.** If a child does not need `load()` and `save()` but the parent declares them abstract, the child is forced to provide dummy implementations that throw exceptions or return null -- a sign that the hierarchy is wrong.

8. **Inheritance breaks when requirements change.** Adding a new axis of variation (e.g., an image that can be drawn on but does not come from a file) requires restructuring the entire hierarchy, breaking all existing subclasses and their consumers. Change is the enemy of inheritance.

9. **Prefer composition.** Separate concerns into independent classes. Each class represents one capability. Combine classes by passing them as parameters (dependency injection) rather than bundling them through inheritance.

10. **Use interfaces (not parent classes) for abstraction.** When you genuinely need polymorphism -- calling a method without knowing which implementation runs -- use an interface. Interfaces define only the critical contract methods and are lightweight. Parent classes share everything by default, making them rigid and expensive to change.

11. **If inheritance is truly unavoidable** (e.g., framework requirement, or 100+ classes needing identical boilerplate where refactoring the plugin model is prohibitively expensive):
    - Avoid protected variables with direct access.
    - Create an explicit protected API -- specific methods that subclasses are meant to override.
    - Make everything else `private`, `final`, or `sealed`.
    - This prevents bugs from subclasses making assumptions about parent internals.

## Procedure

1. **Identify inheritance hierarchies.** For each hierarchy, assess:
   - How many subclasses exist?
   - Are any subclasses forced to implement irrelevant methods (throwing `NotImplementedException`, returning null, providing empty implementations)?
   - Could a new reasonable requirement break the hierarchy?
   - If yes to any → flag for refactoring to composition.

2. **Identify shared interfaces and abstract classes.** For each, count implementations:
   - Fewer than 3 implementations → evaluate whether the coupling is justified by a concrete need (deferred usage, decision/usage separation, testability).
   - If not justified → flag for possible removal (inline the abstraction).

3. **Identify parent classes sharing trivial code.** If a parent class exists only to share one field or one simple method → flag. The coupling cost exceeds the saved duplication.

4. **Refactor inheritance to composition.** For each flagged hierarchy:
   - Remove the parent class.
   - Extract reusable behavior into standalone classes.
   - Have the former subclasses accept these standalone classes as dependencies (constructor parameters).
   - Replace parent-class abstractions with focused interfaces containing only the methods callers actually use.

5. **Remove premature abstractions.** For interfaces with 1-2 implementations and no deferred/repeated usage:
   - Remove the interface.
   - Let the concrete classes stand alone.
   - Use a simple if-statement or switch at the call site.
   - Explain to the user when the abstraction *would* become justified (e.g., "if a third notification channel is added, reintroduce the interface").

6. **Present changes** with a brief explanation of why each abstraction was simplified and when it might be worth re-introducing.

## Adapt to the User's Language

Apply composition using the idioms of the user's language. In languages without interfaces (Python, JavaScript), use protocols, duck typing, or simple function parameters. In languages with explicit interfaces (Java, C#, Go, TypeScript), use interface types. In functional languages, use higher-order functions or type classes.

---

## Examples

### Example A: Premature Interface Removal

An interface with only two implementations, used in one place behind a simple if-statement:

**Before:**

```typescript
interface NotificationSender {
    send(userId: string, message: string): Promise<void>;
}

class EmailSender implements NotificationSender {
    constructor(private smtpConfig: SmtpConfig) {}

    async send(userId: string, message: string): Promise<void> {
        const email = await lookupEmail(userId);
        await this.smtpClient.send(email, message);
    }
}

class SmsSender implements NotificationSender {
    constructor(private twilioKey: string) {}

    async send(userId: string, message: string): Promise<void> {
        const phone = await lookupPhone(userId);
        await this.twilioClient.send(phone, message);
    }
}

// Factory
function createNotificationSender(channel: string): NotificationSender {
    if (channel === "email") return new EmailSender(config.smtp);
    if (channel === "sms") return new SmsSender(config.twilioKey);
    throw new Error(`Unknown channel: ${channel}`);
}

// Usage -- only one call site in the entire codebase
async function notifyUser(userId: string, message: string, channel: string) {
    const sender = createNotificationSender(channel);
    await sender.send(userId, message);
}
```

The interface, factory, and polymorphic dispatch save exactly one line of duplication (the `send` call). The factory just moves the if-statement to a different location. The coupling constrains both implementations to the same method signature and prevents them from evolving independently (e.g., SMS might need a `priority` parameter that email does not).

**After:**

```typescript
class EmailSender {
    constructor(private smtpConfig: SmtpConfig) {}

    async send(userId: string, message: string): Promise<void> {
        const email = await lookupEmail(userId);
        await this.smtpClient.send(email, message);
    }
}

class SmsSender {
    constructor(private twilioKey: string) {}

    async send(userId: string, message: string): Promise<void> {
        const phone = await lookupPhone(userId);
        await this.twilioClient.send(phone, message);
    }
}

async function notifyUser(userId: string, message: string, channel: string) {
    if (channel === "email") {
        await new EmailSender(config.smtp).send(userId, message);
    } else if (channel === "sms") {
        await new SmsSender(config.twilioKey).send(userId, message);
    } else {
        throw new Error(`Unknown channel: ${channel}`);
    }
}
```

The interface and factory are removed. The if-statement is simple, localized, and explicit. Each sender class is independent and can evolve its method signature without affecting the other.

**When to reintroduce the abstraction:** If a third channel is added (push notifications), or if `notifyUser` needs to accept a sender from somewhere else (e.g., a notification scheduler that stores the sender to invoke later), the interface becomes justified because it separates the decision of *which* sender from the act of *sending*.

---

### Example B: Inheritance to Composition

A class hierarchy where a subclass is forced to provide irrelevant implementations:

**Before:**

```python
class Vehicle:
    def __init__(self, make, model, year):
        self.make = make
        self.model = model
        self.year = year
        self.fuel_level = 100

    def drive(self, distance_km):
        fuel_cost = distance_km * self.fuel_consumption_rate()
        if self.fuel_level < fuel_cost:
            raise InsufficientFuelError("Not enough fuel")
        self.fuel_level -= fuel_cost

    def refuel(self, amount):
        self.fuel_level = min(self.fuel_level + amount, 100)

    def fuel_consumption_rate(self):
        raise NotImplementedError

    def max_speed_kmh(self):
        raise NotImplementedError


class GasCar(Vehicle):
    def fuel_consumption_rate(self):
        return 0.08  # liters per km

    def max_speed_kmh(self):
        return 180


class ElectricCar(Vehicle):
    def refuel(self, amount):
        # This is really "recharge" -- the name doesn't fit
        self.fuel_level = min(self.fuel_level + amount, 100)

    def fuel_consumption_rate(self):
        return 0.05  # "fuel" is really battery percentage per km

    def max_speed_kmh(self):
        return 200


class Bicycle(Vehicle):
    def refuel(self, amount):
        pass  # Bicycles don't refuel -- forced to implement this

    def fuel_consumption_rate(self):
        return 0  # Bicycles don't consume fuel

    def drive(self, distance_km):
        pass  # Override to skip fuel check entirely

    def max_speed_kmh(self):
        return 30
```

`Bicycle` overrides nearly everything with no-ops. `ElectricCar` awkwardly reinterprets "fuel" as battery. The hierarchy assumes all vehicles consume fuel, which is false.

**After:**

```python
class VehicleInfo:
    def __init__(self, make, model, year):
        self.make = make
        self.model = model
        self.year = year


class GasEngine:
    def __init__(self, tank_capacity_liters=50, consumption_per_km=0.08):
        self.tank_capacity = tank_capacity_liters
        self.fuel_level = tank_capacity_liters
        self.consumption_per_km = consumption_per_km

    def consume(self, distance_km):
        cost = distance_km * self.consumption_per_km
        if self.fuel_level < cost:
            raise InsufficientFuelError("Not enough fuel")
        self.fuel_level -= cost

    def refill(self, amount):
        self.fuel_level = min(self.fuel_level + amount, self.tank_capacity)


class BatteryPack:
    def __init__(self, capacity_kwh=75, consumption_per_km=0.15):
        self.capacity = capacity_kwh
        self.charge_level = capacity_kwh
        self.consumption_per_km = consumption_per_km

    def consume(self, distance_km):
        cost = distance_km * self.consumption_per_km
        if self.charge_level < cost:
            raise InsufficientChargeError("Not enough charge")
        self.charge_level -= cost

    def recharge(self, amount_kwh):
        self.charge_level = min(self.charge_level + amount_kwh, self.capacity)


# Usage: compose what you need
gas_car = VehicleInfo("Toyota", "Camry", 2024)
gas_engine = GasEngine()

electric_car = VehicleInfo("Tesla", "Model 3", 2024)
battery = BatteryPack()

bicycle = VehicleInfo("Trek", "FX3", 2024)
# No engine or fuel system -- bicycles simply don't have one
```

Each class represents one concept. `GasEngine` and `BatteryPack` are independent -- they can evolve without affecting each other. A `Bicycle` simply does not have an engine, rather than pretending to have one with no-ops. New variations (hybrid with both gas and electric, solar-powered) are added by composing existing pieces, not by restructuring a hierarchy.

---

### Example C: Over-Shared Base Class

A base class that bundles infrastructure concerns, forcing all subclasses to inherit capabilities they may not need:

**Before:**

```java
public abstract class BaseRepository {
    protected Connection connection;
    protected Logger logger;
    protected MetricsCollector metrics;

    public BaseRepository(String connectionString) {
        this.connection = DriverManager.getConnection(connectionString);
        this.logger = LoggerFactory.getLogger(getClass());
        this.metrics = MetricsCollector.getInstance();
    }

    protected void logQuery(String query) {
        logger.debug("Executing: {}", query);
        metrics.increment("db.queries");
    }

    protected ResultSet executeQuery(String query) throws SQLException {
        logQuery(query);
        return connection.createStatement().executeQuery(query);
    }

    public void close() throws SQLException {
        connection.close();
    }
}

public class UserRepository extends BaseRepository {
    public UserRepository(String connectionString) {
        super(connectionString);
    }

    public User findById(int id) throws SQLException {
        ResultSet rs = executeQuery("SELECT * FROM users WHERE id = " + id);
        // ... map result
    }
}

public class ProductRepository extends BaseRepository {
    public ProductRepository(String connectionString) {
        super(connectionString);
    }

    public List<Product> findByCategory(String category) throws SQLException {
        ResultSet rs = executeQuery("SELECT * FROM products WHERE category = '" + category + "'");
        // ... map results
    }
}

// Problem: now we need a CacheRepository that doesn't use a database
public class CacheRepository extends BaseRepository {
    public CacheRepository(String connectionString) {
        super(connectionString); // Forced to provide a connection string we don't need!
    }

    // We override everything to use Redis instead, making inheritance pointless
    public String get(String key) {
        // Uses Redis, not the inherited connection at all
    }
}
```

`BaseRepository` bundles database connection, logging, and metrics into one parent. `CacheRepository` inherits all of this infrastructure but uses none of it.

**After:**

```java
public class DatabaseConnection {
    private final Connection connection;

    public DatabaseConnection(String connectionString) throws SQLException {
        this.connection = DriverManager.getConnection(connectionString);
    }

    public ResultSet executeQuery(String query) throws SQLException {
        return connection.createStatement().executeQuery(query);
    }

    public void close() throws SQLException {
        connection.close();
    }
}

public class QueryLogger {
    private final Logger logger;
    private final MetricsCollector metrics;

    public QueryLogger(Logger logger, MetricsCollector metrics) {
        this.logger = logger;
        this.metrics = metrics;
    }

    public void log(String query) {
        logger.debug("Executing: {}", query);
        metrics.increment("db.queries");
    }
}

public class UserRepository {
    private final DatabaseConnection db;
    private final QueryLogger queryLogger;

    public UserRepository(DatabaseConnection db, QueryLogger queryLogger) {
        this.db = db;
        this.queryLogger = queryLogger;
    }

    public User findById(int id) throws SQLException {
        String query = "SELECT * FROM users WHERE id = " + id;
        queryLogger.log(query);
        ResultSet rs = db.executeQuery(query);
        // ... map result
    }
}

public class ProductRepository {
    private final DatabaseConnection db;
    private final QueryLogger queryLogger;

    public ProductRepository(DatabaseConnection db, QueryLogger queryLogger) {
        this.db = db;
        this.queryLogger = queryLogger;
    }

    public List<Product> findByCategory(String category) throws SQLException {
        String query = "SELECT * FROM products WHERE category = '" + category + "'";
        queryLogger.log(query);
        ResultSet rs = db.executeQuery(query);
        // ... map results
    }
}

// CacheRepository only depends on what it actually needs
public class CacheRepository {
    private final RedisClient redis;

    public CacheRepository(RedisClient redis) {
        this.redis = redis;
    }

    public String get(String key) {
        return redis.get(key);
    }
}
```

`DatabaseConnection` and `QueryLogger` are standalone components, injected into the repositories that need them. `CacheRepository` depends only on `RedisClient` -- it has no inherited database connection it does not use. Each repository declares exactly the dependencies it needs in its constructor. Adding a new type of repository (file-based, API-backed, in-memory) requires no changes to existing code.
