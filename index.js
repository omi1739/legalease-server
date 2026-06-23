const express = require('express');
const cors = require('cors');
const app = express();
const port = 5000;
require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

// Middleware
app.use(cors({
  origin: 'http://localhost:3000',
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
    // Connect the client to the server (optional starting in v4.7)
    await client.connect();
    
    const db = client.db("LEGALEASE");
    const lawyersCollection = db.collection("lawyers");

    // Ping confirmation
    await db.command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");

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