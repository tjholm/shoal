export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailDriver {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

const consoleDriver: EmailDriver = {
  name: "console",
  async send(message) {
    const divider = "─".repeat(64);
    const lines = [
      "",
      `┌${divider}`,
      `│ [email:console] ${message.subject}`,
      `│ To: ${message.to}`,
      `├${divider}`,
      ...message.text.split("\n").map((l) => `│ ${l}`),
      `└${divider}`,
      "",
    ];
    console.log(lines.join("\n"));
  },
};

function makeResendDriver(apiKey: string, from: string): EmailDriver {
  return {
    name: "resend",
    async send(message) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: message.to,
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Resend send failed: ${res.status} ${body}`);
      }
    },
  };
}

function pickDriver(): EmailDriver {
  const resendKey = process.env.RESEND_API_KEY;
  if (resendKey) {
    const from = process.env.EMAIL_FROM;
    if (!from) {
      throw new Error(
        "RESEND_API_KEY is set but EMAIL_FROM is missing — required to send mail via Resend.",
      );
    }
    return makeResendDriver(resendKey, from);
  }
  if (process.env.NODE_ENV === "development") {
    return consoleDriver;
  }
  throw new Error(
    "No email driver configured. Set RESEND_API_KEY (and EMAIL_FROM) for production, or run with NODE_ENV=development to use the console driver.",
  );
}

const driver = pickDriver();

export function sendEmail(message: EmailMessage): Promise<void> {
  return driver.send(message);
}
