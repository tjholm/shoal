---
name: dependency-injection
description: "Refactor code to use dependency injection. Extract interfaces for dependencies, move construction to factories, and make components testable by accepting dependencies as parameters."
user-invocable: true
allowed-tools: Read, Edit, Grep, Glob, Bash
---

# Dependency Injection

When invoked, review the specified code for tightly coupled dependencies -- classes that directly instantiate their collaborators, call static methods on external services, or hard-code configuration. Refactor to inject dependencies through constructors or method parameters, enabling configurability, testability, and clean separation of concerns.

If the user has not specified a scope (file or directory), ask them which file or directory to focus on before proceeding.

## Core Rules

1. **Pass dependencies in instead of creating them internally.** If a class uses another class, that other class should be passed in (injected), not constructed inside. The class should declare what it needs, and the caller fulfills those needs.

2. **Create interfaces for dependencies that may vary.** Define an interface when:
   - The dependency could have multiple implementations (different storage backends, different payment gateways).
   - You want to test the caller independently from the dependency.
   - The dependency is an external service (file system, network, database, third-party API).
   The interface describes *what* the dependency can do, not *how*.

3. **Each implementation gets its own specific configuration.** If `S3Storage` needs an AWS key and `SftpStorage` needs a host and private key, each constructor demands exactly what it needs. No optional parameters that vary by implementation. No "fill out these fields depending on mode" pattern.

4. **Use factories to centralize the decision of which implementation to create.** The factory takes configuration and returns the interface type. This separates "which implementation" from "using the implementation." The consumer of the interface never knows or cares which concrete class it received.

5. **The architecture should be configurable from one location** -- the composition root (main function, startup file, request handler initialization). Changing an implementation should require changes in one place, not scattered throughout the codebase.

6. **Dependencies can be injected at different times:**
   - **At startup** -- most common. The application wires everything together once at initialization.
   - **Per request** -- when the implementation depends on request-specific context (which user, which tenant, which configuration). Factories or request-scoped containers handle this.

7. **Easy testing is a natural side effect.** Each interface boundary is a point where you can slice the system for testing. Inject fakes or mocks to isolate the component under test. If testing requires hacks (reflection, monkey-patching, setting internal state), the code probably needs better dependency injection.

8. **Do not over-inject.** Not every collaborator needs an interface. Pure utility functions (math, string formatting), language built-ins, and value objects do not need injection. Inject at the boundaries where behavior varies or where external systems are accessed.

## Procedure

1. **Identify tightly coupled dependencies.** Look for:
   - `new ConcreteClass()` inside business logic (not in factories or composition roots).
   - Static method calls to external services (`SmtpClient.send()`, `S3.upload()`).
   - Direct file system, network, or database access inside business logic.
   - Configuration values read directly from environment variables or config files deep in the code.

2. **For each dependency, determine if an interface is warranted.** Ask:
   - Is this an external service? → Yes, inject it.
   - Could there be multiple implementations? → Yes, create an interface.
   - Do I want to test the caller without this dependency? → Yes, create an interface.
   - Is this a pure utility with no side effects? → Probably no interface needed.

3. **Extract the interface.** It should contain only the methods the caller actually uses (Interface Segregation Principle). If the caller only calls `upload()`, the interface should only declare `upload()` even if the concrete class has 20 other methods.

4. **Modify the class to accept the interface** through its constructor (for startup-time dependencies) or as a method parameter (for request-time dependencies).

5. **Create a factory** if there are multiple implementations. The factory takes configuration and returns the correct implementation.

6. **Move all construction/wiring to the composition root.** Main, startup, or request initialization should be the only place that knows about concrete implementations.

7. **Verify testability.** Each class should be instantiable in a test with fake/mock dependencies, without needing the real external services.

## Adapt to the User's Language

In dynamically typed languages (Python, JavaScript), interfaces can be implicit (duck typing) or explicit (Python `Protocol`, TypeScript `interface`). In statically typed languages (Java, C#, Go), use the language's interface or trait mechanism. In functional languages, inject dependencies as function parameters or use higher-order functions.

---

## Examples

### Example A: Basic Dependency Extraction

A report generator that directly creates its collaborators:

**Before:**

```python
class ReportGenerator:
    def generate(self, data: dict) -> None:
        # Directly creates a PDF renderer -- can't swap to HTML or test without rendering
        renderer = PdfRenderer(font_size=12, margin=20)
        content = renderer.render(data)

        # Directly creates SMTP client -- can't test without sending real emails
        email_client = SmtpClient("smtp.company.com", 587, "reports@company.com")
        email_client.send(
            to=data["recipient"],
            subject=f"Report for {data['period']}",
            attachment=content,
        )

        # Directly accesses the database -- can't test without a live DB
        db = DatabaseConnection("postgres://prod-server/reports")
        db.execute(
            "INSERT INTO report_log (period, recipient, generated_at) VALUES (?, ?, ?)",
            data["period"], data["recipient"], datetime.now(),
        )
```

This class is impossible to test without rendering a real PDF, sending a real email, and connecting to a real database. Changing the email provider or storage format requires editing this class.

**After:**

```python
from typing import Protocol


class Renderer(Protocol):
    def render(self, data: dict) -> bytes: ...


class EmailService(Protocol):
    def send(self, to: str, subject: str, attachment: bytes) -> None: ...


class ReportLog(Protocol):
    def record(self, period: str, recipient: str, generated_at: datetime) -> None: ...


class ReportGenerator:
    def __init__(self, renderer: Renderer, email: EmailService, log: ReportLog):
        self.renderer = renderer
        self.email = email
        self.log = log

    def generate(self, data: dict) -> None:
        content = self.renderer.render(data)
        self.email.send(
            to=data["recipient"],
            subject=f"Report for {data['period']}",
            attachment=content,
        )
        self.log.record(data["period"], data["recipient"], datetime.now())


# Composition root -- the only place that knows about concrete implementations
def create_report_generator() -> ReportGenerator:
    return ReportGenerator(
        renderer=PdfRenderer(font_size=12, margin=20),
        email=SmtpEmailService("smtp.company.com", 587, "reports@company.com"),
        log=DatabaseReportLog("postgres://prod-server/reports"),
    )
```

`ReportGenerator` now declares what it needs. The composition root wires concrete implementations. Swapping PDF for HTML, or SMTP for SendGrid, is a one-line change in the composition root.

---

### Example B: Factory Pattern for Multiple Implementations

A payment processor with if-chains selecting between providers, each with different configuration:

**Before:**

```typescript
class PaymentProcessor {
    async charge(
        merchantId: string,
        amount: number,
        currency: string,
        // Optional params that vary by provider -- confusing and error-prone
        stripeKey?: string,
        paypalClientId?: string,
        paypalSecret?: string,
        bankAccountNumber?: string,
        bankRoutingNumber?: string,
    ): Promise<ChargeResult> {
        const merchant = await this.merchantDb.getMerchant(merchantId);

        if (merchant.paymentProvider === "stripe") {
            const stripe = new Stripe(stripeKey!);
            const charge = await stripe.charges.create({ amount, currency });
            return { transactionId: charge.id, status: "success" };
        } else if (merchant.paymentProvider === "paypal") {
            const paypal = new PayPalClient(paypalClientId!, paypalSecret!);
            const order = await paypal.createOrder(amount, currency);
            await paypal.capturePayment(order.id);
            return { transactionId: order.id, status: "success" };
        } else if (merchant.paymentProvider === "bank_transfer") {
            const bank = new BankTransferClient(bankAccountNumber!, bankRoutingNumber!);
            const ref = await bank.initiateTransfer(amount, currency);
            return { transactionId: ref, status: "pending" };
        } else {
            throw new Error(`Unknown provider: ${merchant.paymentProvider}`);
        }
    }
}
```

The method has 7 parameters, most optional. The caller must know which ones to fill for each provider. All three provider SDKs are intermingled in one method.

**After:**

```typescript
interface PaymentGateway {
    charge(amount: number, currency: string): Promise<ChargeResult>;
}

class StripeGateway implements PaymentGateway {
    private stripe: Stripe;

    constructor(apiKey: string) {
        this.stripe = new Stripe(apiKey);
    }

    async charge(amount: number, currency: string): Promise<ChargeResult> {
        const charge = await this.stripe.charges.create({ amount, currency });
        return { transactionId: charge.id, status: "success" };
    }
}

class PayPalGateway implements PaymentGateway {
    private client: PayPalClient;

    constructor(clientId: string, secret: string) {
        this.client = new PayPalClient(clientId, secret);
    }

    async charge(amount: number, currency: string): Promise<ChargeResult> {
        const order = await this.client.createOrder(amount, currency);
        await this.client.capturePayment(order.id);
        return { transactionId: order.id, status: "success" };
    }
}

class BankTransferGateway implements PaymentGateway {
    private bank: BankTransferClient;

    constructor(accountNumber: string, routingNumber: string) {
        this.bank = new BankTransferClient(accountNumber, routingNumber);
    }

    async charge(amount: number, currency: string): Promise<ChargeResult> {
        const ref = await this.bank.initiateTransfer(amount, currency);
        return { transactionId: ref, status: "pending" };
    }
}

class PaymentGatewayFactory {
    createForMerchant(merchant: Merchant): PaymentGateway {
        switch (merchant.paymentProvider) {
            case "stripe":
                return new StripeGateway(merchant.config.stripeKey);
            case "paypal":
                return new PayPalGateway(merchant.config.paypalClientId, merchant.config.paypalSecret);
            case "bank_transfer":
                return new BankTransferGateway(merchant.config.bankAccount, merchant.config.bankRouting);
            default:
                throw new Error(`Unknown provider: ${merchant.paymentProvider}`);
        }
    }
}

class PaymentProcessor {
    constructor(
        private merchantDb: MerchantDb,
        private gatewayFactory: PaymentGatewayFactory,
    ) {}

    async charge(merchantId: string, amount: number, currency: string): Promise<ChargeResult> {
        const merchant = await this.merchantDb.getMerchant(merchantId);
        const gateway = this.gatewayFactory.createForMerchant(merchant);
        return gateway.charge(amount, currency);
    }
}
```

`PaymentProcessor.charge()` now has 3 parameters instead of 7. Each gateway has its own class with exactly the configuration it needs -- no optional parameters. The factory centralizes the provider selection logic. Adding a new provider means creating one new class and adding one case to the factory. The processor itself never changes.

---

### Example C: Testing Benefit

The refactored `ReportGenerator` from Example A is now trivially testable:

**Before (attempting to test the original code):**

```python
# How do you test the original ReportGenerator?
# - It renders a real PDF (slow, requires fonts/libraries installed)
# - It sends a real email (side effect! hope you didn't email a customer)
# - It writes to a real database (requires a running Postgres instance)
# You can't test the generate() logic in isolation. You'd need to:
# - Mock at the module level (monkey-patching imports)
# - Set up a test database
# - Intercept SMTP traffic
# All of this is fighting the code's structure.
```

**After (testing with injected fakes):**

```python
class FakeRenderer:
    def __init__(self):
        self.render_calls = []

    def render(self, data: dict) -> bytes:
        self.render_calls.append(data)
        return b"fake-pdf-content"


class FakeEmailService:
    def __init__(self):
        self.sent_emails = []

    def send(self, to: str, subject: str, attachment: bytes) -> None:
        self.sent_emails.append({"to": to, "subject": subject, "attachment": attachment})


class FakeReportLog:
    def __init__(self):
        self.entries = []

    def record(self, period: str, recipient: str, generated_at: datetime) -> None:
        self.entries.append({"period": period, "recipient": recipient})


def test_generate_sends_report_to_recipient():
    renderer = FakeRenderer()
    email = FakeEmailService()
    log = FakeReportLog()
    generator = ReportGenerator(renderer, email, log)

    generator.generate({
        "recipient": "alice@example.com",
        "period": "Q1 2025",
        "revenue": 50000,
    })

    # Verify the renderer was called with our data
    assert len(renderer.render_calls) == 1
    assert renderer.render_calls[0]["revenue"] == 50000

    # Verify the email was sent to the right person with the rendered content
    assert len(email.sent_emails) == 1
    assert email.sent_emails[0]["to"] == "alice@example.com"
    assert email.sent_emails[0]["attachment"] == b"fake-pdf-content"

    # Verify the log was recorded
    assert len(log.entries) == 1
    assert log.entries[0]["period"] == "Q1 2025"
```

The test runs instantly with no external services. Each fake records what happened, letting you verify exactly which methods were called with which arguments. You can test the report generation logic, the email sending logic, and the logging logic in complete isolation.

**Want to integration test rendering + email together but not the database?** Inject the real `PdfRenderer` and `SmtpEmailService` but a fake `ReportLog`. You can mix and match real and fake implementations at each boundary -- that is the power of dependency injection.
