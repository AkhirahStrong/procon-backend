import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { createClient } from "@supabase/supabase-js";
import bodyParser from "body-parser";

dotenv.config();

const app = express();

const corsOptions = {
  origin: "chrome-extension://kcjaihgieglabaicpaleaacjdnjleegm", // <--- YOUR extension ID
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
};

app.use(cors());
app.options("*", cors());

app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ✅ Stripe Webhook: save user email to Supabase when checkout is completed
app.post(
  "/stripe-webhook",
  (req, res, next) => {
    if (req.method === "POST") {
      bodyParser.raw({ type: "application/json" })(req, res, next);
    } else {
      next();
    }
  },
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = Stripe(process.env.STRIPE_SECRET_KEY).webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      console.error("❌ Webhook verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_details?.email;

      console.log("✅ Stripe Checkout Complete for:", email);

      if (!email) {
        console.warn("⚠️ No email found in session");
        return res.status(400).send("Missing email");
      }

      const { error } = await supabase.from("pro_users").insert([
        {
          email,
          isPro: true,
          upgradedAt: new Date().toISOString(),
        },
      ]);

      if (error) {
        console.error("❌ Supabase insert error:", error);
        return res.status(500).send("Failed to store Pro user");
      }

      console.log("📬 Pro user saved to Supabase:", email);
    }

    res.status(200).json({ received: true });
  },
);

// 🧠 Check if email is Pro in Supabase
async function isProUserByEmail(email) {
  const { data, error } = await supabase
    .from("pro_users")
    .select("isPro")
    .eq("email", email)
    .maybeSingle();

  console.log("🔍 Pro check result:", { email, data, error });

  if (error) return false;
  return data?.isPro === true;
}

// 🧪 Check Pro status via email
app.get("/check-pro", async (req, res) => {
  const email = req.query.email;
  if (!email)
    return res.status(400).json({ isPro: false, error: "Missing email" });

  const result = await isProUserByEmail(email);
  res.json({ isPro: result });
});

// Send check pro status
app.post("/check-pro", async (req, res) => {
  const email = req.body.email; // ✅ read from body instead of query

  if (!email) {
    return res.status(400).json({ isPro: false, error: "Missing email" });
  }

  const result = await isProUserByEmail(email);
  res.json({ isPro: result });
});

// 🎟️ Stripe Checkout Session (email passed from frontend)
app.post("/create-checkout-session", async (req, res) => {
  const { priceId, email } = req.body;

  if (!email) return res.status(400).json({ error: "Missing email" });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://your-replit-url/success.html",
      cancel_url: "https://your-replit-url/cancel.html",
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error("❌ Stripe Checkout Error:", error);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// 🧠 GPT Analyze Route (Pro check using email)
app.post("/analyze", async (req, res) => {
  const { selectedText, email } = req.body;

  if (!selectedText || !email) {
    return res.status(400).json({ error: "Missing selectedText or email" });
  }

  // 🛡️ Check Pro access
  const isPro = await isProUserByEmail(email);
  if (isPro) {
    console.log("💎 Pro access granted to:", email);
  } else {
    console.log("🔒 Free user:", email);
    // Optional: Add rate limiting for free users here
  }

  try {
    const openaiRes = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o",
          messages: [
            {
              role: "system",
              content:
                "You are a privacy policy analyst. Break down privacy agreements into clear pros, cons, and red flags using bullet points or headers. Be detailed and unbiased.",
            },
            { role: "user", content: selectedText },
          ],
        }),
      },
    );

    const data = await openaiRes.json();

    if (data.choices?.[0]?.message?.content) {
      res.json({ summary: data.choices[0].message?.content });
    } else {
      res.status(500).json({ error: "OpenAI response failed.", data });
    }
  } catch (err) {
    console.error("OpenAI API error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// 🎯 Basic test route
app.get("/", (req, res) => {
  res.send("🧠 Privacy GPT API is live with Email-Based Pro Access");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
