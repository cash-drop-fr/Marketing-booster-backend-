const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const admin = require("firebase-admin");

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Firebase Admin init
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});
const db = admin.firestore();

app.use(cors({ origin: process.env.FRONTEND_URL }));

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

    const session = event.data.object;

    switch (event.type) {
      // Abonnement créé ou renouvelé
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const sub = event.data.object;
        const uid = sub.metadata.firebaseUID;
        if (!uid) break;

        const priceId = sub.items.data[0].price.id;
        const plan =
          priceId === process.env.STRIPE_PRICE_PRO
            ? "pro"
            : priceId === process.env.STRIPE_PRICE_ELITE
            ? "elite"
            : "free";

        await db.collection("users").doc(uid).set(
          {
            plan,
            stripeCustomerId: sub.customer,
            stripeSubscriptionId: sub.id,
            subscriptionStatus: sub.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        break;
      }

      // Abonnement annulé
      case "customer.subscription.deleted": {
        const sub = event.data.object;
        const uid = sub.metadata.firebaseUID;
        if (!uid) break;

        await db.collection("users").doc(uid).set(
          {
            plan: "free",
            subscriptionStatus: "canceled",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        break;
      }
    }

    res.json({ received: true });
  }
);

app.use(express.json());

// Créer une session Stripe Checkout
app.post("/create-checkout-session", async (req, res) => {
  const { priceId, firebaseUID, email } = req.body;

  if (!priceId || !firebaseUID || !email) {
    return res.status(400).json({ error: "Paramètres manquants" });
  }

  try {
    // Chercher ou créer le customer Stripe
    const userDoc = await db.collection("users").doc(firebaseUID).get();
    let customerId = userDoc.exists ? userDoc.data().stripeCustomerId : null;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        metadata: { firebaseUID },
      });
      customerId = customer.id;
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ["card"],
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        metadata: { firebaseUID },
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

// Portail client Stripe (gérer/annuler abonnement)
app.post("/create-portal-session", async (req, res) => {
  const { firebaseUID } = req.body;

  try {
    const userDoc = await db.collection("users").doc(firebaseUID).get();
    const customerId = userDoc.data()?.stripeCustomerId;

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
