const express = require('express');
const cors = require('cors');
const app = express();
const port = process.env.PORT || 5000;
require('dotenv').config();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || 'sk_test_51Pq3H1RxY27v317z357r89182312389172389172389123812318');

// Middleware
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());

const uri = process.env.MONGODB_URI;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server
    await client.connect();
    
    const db = client.db("LEGALEASE");
    const lawyersCollection = db.collection("lawyers");
    const hiresCollection = db.collection("hires");
    const commentsCollection = db.collection("comments");
    const usersCollection = db.collection("user");

    // Ping confirmation
    await db.command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");

    // Helper: Verify session token
    const verifySession = async (req, res, next) => {
      try {
        let token = null;
        // console.log("verifySession - Received headers:", req.headers);
        
        // 1. Try to get token from Authorization header
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith("Bearer ")) {
          token = authHeader.split(" ")[1];
        }
        
        // 2. Try to get token from cookies
        if (!token && req.headers.cookie) {
          const cookies = req.headers.cookie.split(';').map(c => c.trim());
          // console.log("verifySession - Parsed cookies:", cookies);
          const sessionCookie = cookies.find(c => c.startsWith('better-auth.session_token='));
          if (sessionCookie) {
            token = sessionCookie.substring('better-auth.session_token='.length);
          }
        }

        // Better Auth tokens in cookie are stored as 'token.signature'.
        // We only need the actual 'token' part before the dot to query the database.
        if (token && token.includes('.')) {
          token = token.split('.')[0];
        }

        // console.log("verifySession - Resolved token:", token);

        if (!token) {
          return res.status(401).json({ error: "Unauthorized: No token provided" });
        }

        const session = await db.collection("session").findOne({ token });
        if (!session || new Date(session.expiresAt) < new Date()) {
          return res.status(401).json({ error: "Unauthorized: Invalid or expired session" });
        }

        // Better Auth user ID corresponds to user collection's _id
        const user = await db.collection("user").findOne({ _id: session.userId });
        if (!user) {
          return res.status(401).json({ error: "Unauthorized: User not found" });
        }
        req.user = user;
        next();
      } catch (err) {
        console.error("Session verification error:", err);
        res.status(500).json({ error: "Internal server error during verification" });
      }
    };

    // GET /lawyers - Fetch all lawyers with search, filter, and pagination
    app.get('/lawyers', async (req, res) => {
      try {
        const { search, specialization, minFee, maxFee, isAvailable, page = 1, limit = 6 } = req.query;

        // Build query
        const query = {};

        // Search: matches name or specialization case-insensitively
        if (search) {
          query.$or = [
            { name: { $regex: search, $options: 'i' } },
            { specialization: { $regex: search, $options: 'i' } }
          ];
        }

        // Filter by Specialization/Category
        if (specialization && specialization !== 'All') {
          query.specialization = specialization;
        }

        // Filter by Fee Range
        if (minFee || maxFee) {
          query.hourlyRate = {};
          if (minFee) query.hourlyRate.$gte = Number(minFee);
          if (maxFee) query.hourlyRate.$lte = Number(maxFee);
        }

        // Filter by Availability
        if (isAvailable !== undefined && isAvailable !== '') {
          query.isAvailable = isAvailable === 'true';
        }

        // Pagination calculations
        const pageNum = parseInt(page);
        const limitNum = parseInt(limit);
        const skip = (pageNum - 1) * limitNum;

        // Fetch data
        const totalCount = await lawyersCollection.countDocuments(query);
        const lawyers = await lawyersCollection
          .find(query)
          .skip(skip)
          .limit(limitNum)
          .toArray();

        const totalPages = Math.ceil(totalCount / limitNum);

        res.json({
          lawyers,
          totalCount,
          totalPages,
          currentPage: pageNum,
        });
      } catch (err) {
        console.error("Error fetching lawyers:", err);
        res.status(500).json({ error: "Failed to fetch lawyers data" });
      }
    });

    // GET /lawyers/:name - Fetch a single lawyer by name
    app.get('/lawyers/:name', async (req, res) => {
      try {
        const lawyer = await lawyersCollection.findOne({ name: req.params.name });
        if (!lawyer) {
          return res.status(404).json({ error: "Lawyer not found" });
        }
        res.json(lawyer);
      } catch (err) {
        console.error("Error fetching lawyer profile:", err);
        res.status(500).json({ error: "Failed to fetch lawyer profile" });
      }
    });

    // GET /lawyers/email/:email - Fetch a lawyer by their email
    app.get('/lawyers/email/:email', async (req, res) => {
      try {
        const lawyer = await lawyersCollection.findOne({ email: req.params.email });
        if (!lawyer) {
          return res.status(404).json({ error: "Lawyer profile not found" });
        }
        res.json(lawyer);
      } catch (err) {
        console.error("Error fetching lawyer by email:", err);
        res.status(500).json({ error: "Failed to fetch lawyer profile" });
      }
    });

    // PUT /lawyers - Create or update a lawyer's profile
    app.put('/lawyers', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'lawyer') {
          return res.status(403).json({ error: "Only lawyers can publish profiles" });
        }
        const profile = req.body;
        const result = await lawyersCollection.updateOne(
          { email: req.user.email },
          { 
            $set: {
              name: profile.name || req.user.name,
              email: req.user.email,
              specialization: profile.specialization,
              bio: profile.bio,
              hourlyRate: Number(profile.hourlyRate),
              isAvailable: profile.isAvailable === true,
              avatar: profile.avatar || req.user.image,
              hires: profile.hires || 0,
              rating: profile.rating || 5.0
            }
          },
          { upsert: true }
        );

        // Sync the image/avatar back to the user collection for display in dashboard/navbar
        if (profile.avatar) {
          await usersCollection.updateOne(
            { email: req.user.email },
            { $set: { image: profile.avatar } }
          );
        }

        res.json({ message: "Lawyer profile updated successfully", result });
      } catch (err) {
        console.error("Error updating lawyer profile:", err);
        res.status(500).json({ error: "Failed to save profile" });
      }
    });

    // PATCH /users/:email - Update user profile (name and image)
    app.patch('/users/:email', verifySession, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res.status(403).json({ error: "Forbidden: You cannot modify other users" });
        }
        const { name, image } = req.body;
        const result = await usersCollection.updateOne(
          { email: req.params.email },
          { $set: { name, image } }
        );
        if (result.matchedCount === 0) {
          return res.status(404).json({ error: "User not found" });
        }
        res.json({ message: "Profile updated successfully" });
      } catch (err) {
        console.error("Error updating user profile:", err);
        res.status(500).json({ error: "Failed to update profile" });
      }
    });

    // --- HIRES & TRANSACTIONS ENDPOINTS ---

    // POST /hires - Create a new hire request
    app.post('/hires', verifySession, async (req, res) => {
      try {
        const { lawyerName, lawyerEmail, specialization, fee } = req.body;
        const hireRequest = {
          clientName: req.user.name,
          clientEmail: req.user.email,
          lawyerName,
          lawyerEmail,
          specialization,
          fee: Number(fee),
          date: new Date(),
          status: "pending"
        };
        const result = await hiresCollection.insertOne(hireRequest);
        res.json({ message: "Hiring request sent successfully", result });
      } catch (err) {
        console.error("Error creating hire request:", err);
        res.status(500).json({ error: "Failed to create hire request" });
      }
    });

    // GET /hires/user/:email - Retrieve hiring history for a client
    app.get('/hires/user/:email', verifySession, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const hires = await hiresCollection.find({ clientEmail: req.params.email }).toArray();
        res.json(hires);
      } catch (err) {
        console.error("Error retrieving client hires:", err);
        res.status(500).json({ error: "Failed to load hiring history" });
      }
    });

    // GET /hires/lawyer/:email - Retrieve hiring requests for a lawyer
    app.get('/hires/lawyer/:email', verifySession, async (req, res) => {
      try {
        if (req.user.email !== req.params.email || req.user.role !== 'lawyer') {
          return res.status(403).json({ error: "Forbidden" });
        }
        const hires = await hiresCollection.find({ lawyerEmail: req.params.email }).toArray();
        res.json(hires);
      } catch (err) {
        console.error("Error retrieving lawyer hires:", err);
        res.status(500).json({ error: "Failed to load requests" });
      }
    });

    // PATCH /hires/:id - Update hire status (accepted, rejected, paid)
    app.patch('/hires/:id', verifySession, async (req, res) => {
      try {
        const { status, transactionId } = req.body;
        const id = new ObjectId(req.params.id);

        const hire = await hiresCollection.findOne({ _id: id });
        if (!hire) {
          return res.status(404).json({ error: "Hiring record not found" });
        }

        // Validate access
        const isLawyer = req.user.email === hire.lawyerEmail && req.user.role === 'lawyer';
        const isClient = req.user.email === hire.clientEmail;

        if (!isLawyer && !isClient) {
          return res.status(403).json({ error: "Forbidden" });
        }

        const updateData = { status };
        if (transactionId) {
          updateData.transactionId = transactionId;
          // Increment lawyer's hire count
          await lawyersCollection.updateOne(
            { email: hire.lawyerEmail },
            { $inc: { hires: 1 } }
          );
        }

        const result = await hiresCollection.updateOne(
          { _id: id },
          { $set: updateData }
        );

        res.json({ message: `Hiring request marked as ${status}`, result });
      } catch (err) {
        console.error("Error updating hire status:", err);
        res.status(500).json({ error: "Failed to update status" });
      }
    });

    // --- COMMENTS ENDPOINTS ---

    // GET /comments/:lawyerName - Get comments for a lawyer
    app.get('/comments/:lawyerName', async (req, res) => {
      try {
        const comments = await commentsCollection
          .find({ lawyerName: req.params.lawyerName })
          .toArray();
        res.json(comments);
      } catch (err) {
        console.error("Error retrieving comments:", err);
        res.status(500).json({ error: "Failed to load comments" });
      }
    });

    // GET /comments/user/:email - Get comments written by a user
    app.get('/comments/user/:email', verifySession, async (req, res) => {
      try {
        if (req.user.email !== req.params.email) {
          return res.status(403).json({ error: "Forbidden" });
        }
        const comments = await commentsCollection
          .find({ clientEmail: req.params.email })
          .toArray();
        res.json(comments);
      } catch (err) {
        console.error("Error retrieving user comments:", err);
        res.status(500).json({ error: "Failed to load comments" });
      }
    });

    // POST /comments - Add a new comment
    app.post('/comments', verifySession, async (req, res) => {
      try {
        const { lawyerName, content, rating } = req.body;

        // Verify hiring record matches
        const hasHired = await hiresCollection.findOne({
          clientEmail: req.user.email,
          lawyerName,
          status: "paid"
        });

        if (!hasHired) {
          return res.status(403).json({
            error: "Forbidden: Only clients who have completed payments for this lawyer can leave a review."
          });
        }

        const newComment = {
          clientName: req.user.name,
          clientEmail: req.user.email,
          lawyerName,
          content,
          rating: Number(rating) || 5,
          date: new Date().toISOString().split('T')[0]
        };

        const result = await commentsCollection.insertOne(newComment);
        res.json({ message: "Review posted successfully", result });
      } catch (err) {
        console.error("Error posting comment:", err);
        res.status(500).json({ error: "Failed to save comment" });
      }
    });

    // PATCH /comments/:id - Edit comment
    app.patch('/comments/:id', verifySession, async (req, res) => {
      try {
        const id = new ObjectId(req.params.id);
        const { content, rating } = req.body;

        const comment = await commentsCollection.findOne({ _id: id });
        if (!comment) {
          return res.status(404).json({ error: "Comment not found" });
        }

        if (comment.clientEmail !== req.user.email) {
          return res.status(403).json({ error: "Forbidden: You did not write this comment" });
        }

        const result = await commentsCollection.updateOne(
          { _id: id },
          { $set: { content, rating: Number(rating) || 5 } }
        );

        res.json({ message: "Review updated successfully", result });
      } catch (err) {
        console.error("Error updating comment:", err);
        res.status(500).json({ error: "Failed to update review" });
      }
    });

    // DELETE /comments/:id - Delete comment
    app.delete('/comments/:id', verifySession, async (req, res) => {
      try {
        const id = new ObjectId(req.params.id);

        const comment = await commentsCollection.findOne({ _id: id });
        if (!comment) {
          return res.status(404).json({ error: "Comment not found" });
        }

        if (comment.clientEmail !== req.user.email && req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden" });
        }

        const result = await commentsCollection.deleteOne({ _id: id });
        res.json({ message: "Review deleted successfully", result });
      } catch (err) {
        console.error("Error deleting comment:", err);
        res.status(500).json({ error: "Failed to delete review" });
      }
    });

    // --- STRIPE PAYMENT INTEGRATION ---
    app.post('/payments/create-payment-intent', verifySession, async (req, res) => {
      try {
        const { price } = req.body;
        const amount = Math.round(Number(price) * 100); // Amount in cents

        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amount,
            currency: 'usd',
            payment_method_types: ['card']
          });

          res.send({
            clientSecret: paymentIntent.client_secret,
          });
        } catch (stripeErr) {
          console.warn("Stripe key is missing or invalid. Falling back to mock client secret for local testing:", stripeErr.message);
          res.send({
            clientSecret: `mock_secret_${Math.random().toString(36).substr(2, 9)}`,
          });
        }
      } catch (err) {
        console.error("Payment intent creation error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // --- ADMIN ENDPOINTS ---

    // GET /admin/users - List all users
    app.get('/admin/users', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden: Admin access only" });
        }
        const users = await usersCollection.find().toArray();
        res.json(users);
      } catch (err) {
        console.error("Error retrieving users list:", err);
        res.status(500).json({ error: "Failed to load users list" });
      }
    });

    // PATCH /admin/users/:email - Update user role
    app.patch('/admin/users/:email', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden: Admin access only" });
        }
        if (req.user.email === req.params.email) {
          return res.status(400).json({ error: "Bad Request: You cannot change your own role." });
        }
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { email: req.params.email },
          { $set: { role } }
        );
        res.json({ message: "User role updated successfully", result });
      } catch (err) {
        console.error("Error updating user role:", err);
        res.status(500).json({ error: "Failed to update role" });
      }
    });

    // DELETE /admin/users/:id - Delete a user
    app.delete('/admin/users/:id', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden: Admin access only" });
        }
        if (req.user._id.toString() === req.params.id) {
          return res.status(400).json({ error: "Bad Request: You cannot delete your own account." });
        }
        const result = await usersCollection.deleteOne({ _id: new ObjectId(req.params.id) });
        res.json({ message: "User deleted successfully", result });
      } catch (err) {
        console.error("Error deleting user:", err);
        res.status(500).json({ error: "Failed to delete user" });
      }
    });

    // GET /admin/transactions - Retrieve transaction history (paid hires)
    app.get('/admin/transactions', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden: Admin access only" });
        }
        const transactions = await hiresCollection.find({ status: "paid" }).toArray();
        res.json(transactions);
      } catch (err) {
        console.error("Error retrieving transactions:", err);
        res.status(500).json({ error: "Failed to load transactions list" });
      }
    });

    // GET /admin/analytics - Total stats
    app.get('/admin/analytics', verifySession, async (req, res) => {
      try {
        if (req.user.role !== 'admin') {
          return res.status(403).json({ error: "Forbidden: Admin access only" });
        }

        const totalUsers = await usersCollection.countDocuments();
        const totalLawyers = await lawyersCollection.countDocuments();
        const totalHires = await hiresCollection.countDocuments({ status: "paid" });
        
        const payments = await hiresCollection.find({ status: "paid" }).toArray();
        const totalRevenue = payments.reduce((sum, item) => sum + (item.fee || 0), 0);

        res.json({
          totalUsers,
          totalLawyers,
          totalHires,
          totalRevenue
        });
      } catch (err) {
        console.error("Error calculating analytics:", err);
        res.status(500).json({ error: "Failed to load statistics" });
      }
    });

  } catch (error) {
    console.error("Database connection error:", error);
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('LegalEase Server is running!');
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});

module.exports = app;