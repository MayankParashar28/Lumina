const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const User = require("../models/user"); // Assuming you have a User model

// Middleware to parse JSON (for webhook handling)
router.use(express.json());


// ✅ Stripe Checkout Session
router.post("/create-checkout-session", async (req, res) => {
    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "subscription",
            line_items: [
                {
                    price: "price_1R0cOP2KM38905tQf1WC0NOa", // Use correct Price ID
                    quantity: 1,
                },
            ],
            success_url: "http://localhost:3000/success",
            cancel_url: "http://localhost:3000/cancel",
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error("Stripe Error:", error);
        res.status(400).json({ error: error.message });
    }
});

// ✅ Stripe Webhook to Update Subscription Status
router.post("/webhook", express.raw({ type: "application/json" }), async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error(`Webhook error: ${err.message}`);
        return res.status(400).send(`Webhook error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;

        try {
            const customer = await stripe.customers.retrieve(session.customer);
            const userEmail = customer.email;

            if (!userEmail) {
                console.error("❌ No email found for the customer");
                return res.status(400).json({ error: "No email found" });
            }

            // ✅ Update user subscription status in the database
            const user = await User.findOneAndUpdate(
                { email: userEmail },
                { isSubscribed: true },
                { new: true }
            );

            if (user) {
                console.log(`✅ Subscription activated for ${userEmail}`);
            } else {
                console.log(`❌ No user found with email: ${userEmail}`);
            }

        } catch (error) {
            console.error("Error updating user subscription:", error);
            return res.status(500).json({ error: "Internal Server Error" });
        }
    }

    res.json({ received: true });
});

module.exports = router;