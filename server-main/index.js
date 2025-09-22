import express from "express";
import cors from "cors";
import path from "path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import leoProfanity from "leo-profanity";
import pool from "./db.js";   // ✅ use db.js

dotenv.config();
leoProfanity.loadDictionary(); // offline abuse detection

// ======= Cloudinary config =======
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET,
});

const storage = new CloudinaryStorage({
  cloudinary,
  params: async (req, file) => ({
    folder: "sliss_students",
    resource_type: file.mimetype.startsWith("image/") ? "image" : "raw",
    public_id: `${Date.now()}_${file.originalname.split(".")[0]}`,
  }),
});

const upload = multer({ storage });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ============================
// 🧠 Helper: Check abusive content
// ============================
function isAbusive(text) {
  return leoProfanity.check(text);
}

// ============================
// 📌 Library Routes
// ============================

// Get book details (for admin)
app.get("/api/library/book", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM books ORDER BY id DESC LIMIT 1");
  res.json(rows[0] || {});
});

// Update book details
app.post("/api/library/book", async (req, res) => {
  const { book_name, issue_date, return_date, fine_amount } = req.body;
  if (!book_name || !issue_date || !return_date || fine_amount == null) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const { rows } = await pool.query("SELECT * FROM books LIMIT 1");
  if (rows.length > 0) {
    await pool.query(
      "UPDATE books SET book_name=$1, issue_date=$2, return_date=$3, fine_amount=$4 WHERE id=$5",
      [book_name, issue_date, return_date, fine_amount, rows[0].id]
    );
  } else {
    await pool.query(
      "INSERT INTO books (book_name, issue_date, return_date, fine_amount) VALUES ($1,$2,$3,$4)",
      [book_name, issue_date, return_date, fine_amount]
    );
  }

  res.json({ message: "Book details updated successfully" });
});

// Get all seats
app.get("/api/library/seats", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM seats ORDER BY seat_number");
  res.json(rows);
});

// Update seat status
app.put("/api/library/seats/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!["green", "red"].includes(status)) {
    return res.status(400).json({ message: "Invalid seat status" });
  }
  await pool.query("UPDATE seats SET status=$1 WHERE id=$2", [status, id]);
  res.json({ message: `Seat ${id} status updated to ${status}` });
});

// Combined Library Data Route (Student Portal)
app.get("/api/library", async (req, res) => {
  try {
    const { rows: books } = await pool.query("SELECT * FROM books ORDER BY id DESC LIMIT 1");
    const { rows: seats } = await pool.query("SELECT * FROM seats ORDER BY seat_number");

    res.json({
      book: books[0] || null,
      seats: seats.map(seat => ({
        id: seat.id,
        seat_number: seat.seat_number,
        status: seat.status,
      })),
    });
  } catch (err) {
    console.error("Error fetching library data:", err);
    res.status(500).json({ message: "Failed to fetch library data" });
  }
});

// ============================
// 📌 Notice Routes
// ============================
app.get("/api/notices", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM notices ORDER BY date DESC");
  res.json(rows);
});

app.post("/api/notices", async (req, res) => {
  const { title, category, date, content } = req.body;
  if (!title || !category || !date || !content) {
    return res.status(400).json({ message: "All fields are required" });
  }
  await pool.query(
    "INSERT INTO notices (title, category, date, content) VALUES ($1,$2,$3,$4)",
    [title, category, date, content]
  );
  res.json({ message: "Notice added successfully" });
});

// ============================
// 🧠 Complaint Routes
// ============================
app.post("/api/support", async (req, res) => {
  const { complaint } = req.body;
  if (!complaint || complaint.trim() === "") {
    return res.status(400).json({ message: "Complaint is required" });
  }
  if (isAbusive(complaint)) {
    return res
      .status(400)
      .json({ message: "Complaint contains abusive language. Please rephrase." });
  }
  await pool.query("INSERT INTO complaints (complaint) VALUES ($1)", [complaint]);
  res.json({ message: "Complaint submitted successfully" });
});

app.get("/api/support", async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, complaint, created_at FROM complaints ORDER BY id DESC"
  );
  res.json(rows);
});

// ============================
// 🏠 Hostel Management Routes
// ============================

// Get all rooms for a hostel
app.get("/api/rooms/:hostel", async (req, res) => {
  const { hostel } = req.params;
  const { rows } = await pool.query(
    "SELECT id, room_id, type, seats, available FROM rooms WHERE hostel=$1 ORDER BY room_id",
    [hostel]
  );
  res.json(rows);
});

// Book a room
app.post("/api/rooms/book", async (req, res) => {
  const { room_id } = req.body;
  if (!room_id) return res.status(400).json({ message: "room_id is required" });

  const { rows } = await pool.query("SELECT * FROM rooms WHERE room_id=$1", [room_id]);
  if (rows.length === 0) return res.status(404).json({ message: "Room not found" });

  if (!rows[0].available) {
    return res.status(400).json({ message: "Room already booked" });
  }

  await pool.query("UPDATE rooms SET available=false WHERE room_id=$1", [room_id]);
  res.json({ message: `Room ${room_id} booked successfully` });
});

// Update room info
app.put("/api/rooms/:id", async (req, res) => {
  const { id } = req.params;
  const { type, seats, available } = req.body;

  if (!type || !seats || typeof available !== "boolean") {
    return res.status(400).json({ message: "All fields are required" });
  }

  await pool.query(
    "UPDATE rooms SET type=$1, seats=$2, available=$3 WHERE id=$4",
    [type, seats, available, id]
  );
  res.json({ message: "Room updated successfully" });
});

// Add new room
app.post("/api/rooms/add", async (req, res) => {
  const { room_id, hostel, type, seats } = req.body;
  if (!room_id || !hostel || !type || !seats) {
    return res.status(400).json({ message: "All fields are required" });
  }
  await pool.query(
    "INSERT INTO rooms (room_id, hostel, type, seats, available) VALUES ($1,$2,$3,$4,true)",
    [room_id, hostel, type, seats]
  );
  res.json({ message: "Room added successfully" });
});

// ============================
// Serve frontend
// ============================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ============================
// Start server
// ============================
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
