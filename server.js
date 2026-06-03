const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

const FIREBASE_PROJECT_ID = "flashmail-5650b";
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

app.use(cors({ origin: process.env.FRONTEND_URL }));

// Helpers Firestore REST API
async function getFirestoreDoc(collection, docId) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return await res.json();
}

async function setFirestoreDoc(collection, docId, data) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
  
  // Convertir les données en format Firestore
  const fields = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "string") fields[key] = { stringValue: value };
    else if (typeof value === "number") fields[key] = { integerValue: value };
    else if (typeof value === "boolean") fields[key] = { booleanValue: value };
  }

  const res = await fetch(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fields }),
  });
  return await res.json();
}

function getFieldValue(doc, field) {
  if (!doc || !doc.fields || !doc.fields[field]) return null;
  const f = doc.fields[field];
  return f.stringValue || f.integerValue || f.booleanValue || null;
}

// Webhook Stripe — doit être AVANT express.json()
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const uid = sub.metadata.firebaseUID;
        const plan = sub.metadata.plan || "free";
        if (!uid) break;

        await setFirestoreDoc("users", uid, {
          plan,
          stripeCustomerId: sub.customer,
          stripeSubscriptionId: sub.id,
          subscriptionStatus: sub.status,
        });
        break;
      }

      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = sub.metadata.firebaseUID;
        if (!uid) break;

        await setFirestoreDoc("users", uid, {
          plan: "free",
          subscriptionStatus: "canceled",
        });
        break;
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// Plans disponibles
const PLANS = {
  pro: { name: "Marketing Booster Pro", amount: 2500, currency: "eur" },
  elite: { name: "Marketing Booster Elite", amount: 9900, currency: "eur" },
};

// Créer une session Stripe Checkout
app.post("/create-checkout-session", async (req, res) => {
  const { plan, firebaseUID, email } = req.body;

  if (!plan || !firebaseUID || !email || !PLANS[plan]) {
    return res.status(400).json({ error: "Paramètres manquants ou plan invalide" });
  }

  try {
    const userDoc = await getFirestoreDoc("users", firebaseUID);
    let customerId = getFieldValue(userDoc, "stripeCustomerId");

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { firebaseUID },
      });
      customerId = customer.id;
    }

    const selectedPlan = PLANS[plan];

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [
        {
          price_data: {
            currency: selectedPlan.currency,
            product_data: { name: selectedPlan.name },
            unit_amount: selectedPlan.amount,
            recurring: { interval: "month" },
          },
          quantity: 1,
        },
      ],
      subscription_data: {
        metadata: { firebaseUID, plan },
      },
      success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/#tarifs`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Checkout error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Portail client Stripe
app.post("/create-portal-session", async (req, res) => {
  const { firebaseUID } = req.body;

  try {
    const userDoc = await getFirestoreDoc("users", firebaseUID);
    const customerId = getFieldValue(userDoc, "stripeCustomerId");

    if (!customerId) {
      return res.status(404).json({ error: "Customer non trouvé" });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: process.env.FRONTEND_URL,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Portal error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
