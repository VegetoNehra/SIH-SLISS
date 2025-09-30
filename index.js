import express from "express";
import cors from "cors";
import path from "path";
import multer from "multer";
import { v2 as cloudinary } from "cloudinary";
import { CloudinaryStorage } from "multer-storage-cloudinary";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import leoProfanity from "leo-profanity";
import jwt from "jsonwebtoken";
import pool from "./db.js";   // ✅ use db.js
import { v4 as uuidv4 } from "uuid"; // add this at the top

dotenv.config();
leoProfanity.loadDictionary(); // offline abuse 




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
app.use(express.urlencoded({ extended: true }));


// ============================
// 🧠 Helper: Check abusive content
// ============================
function isAbusive(text) {
  return leoProfanity.check(text);
}


import fs from "fs"; // make sure this is at the top with other imports

// ============================
// Static Serving
// ============================
app.use("/student", express.static(path.join(__dirname, "public", "student")));
app.use("/admin", express.static(path.join(__dirname, "public", "admin")));
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));
app.use("/images", express.static(path.join(__dirname, "public", "images")));

// Default → student homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "student", "index.html"));
});

// Student pages fallback (so /submit.html, /about.html etc. work)
app.get("/:page.html", (req, res, next) => {
  const page = req.params.page;
  const studentPath = path.join(__dirname, "public", "student", `${page}.html`);
  if (fs.existsSync(studentPath)) {
    return res.sendFile(studentPath);
  }
  next();
});

// Admin pages fallback (so /admin/index.html etc. work)
app.get("/admin/:page.html", (req, res, next) => {
  const page = req.params.page;
  const adminPath = path.join(__dirname, "public", "admin", `${page}.html`);
  if (fs.existsSync(adminPath)) {
    return res.sendFile(adminPath);
  }
  next();
});




// ============================
// 📌 Library Book Routes (per user)
// ============================

// ✅ Get a student's book (for admin or student)
app.get("/api/library/book/:userid", async (req, res) => {
  const { userid } = req.params;
  try {
    const { rows } = await pool.query("SELECT * FROM books WHERE userid=$1", [userid]);
    if (rows.length === 0) return res.json(null);
    res.json(rows[0]);
  } catch (err) {
    console.error("Error fetching book:", err);
    res.status(500).json({ message: "Failed to fetch book" });
  }
});

// ✅ Issue or update a book for a student
app.post("/api/library/book", async (req, res) => {
  const { userid, book_name, issue_date, return_date, fine_amount } = req.body;

  if (!userid || !book_name || !issue_date || !return_date || fine_amount == null) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const result = await pool.query(
      `INSERT INTO books (userid, book_name, issue_date, return_date, fine_amount)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (userid)
       DO UPDATE SET 
         book_name = EXCLUDED.book_name,
         issue_date = EXCLUDED.issue_date,
         return_date = EXCLUDED.return_date,
         fine_amount = EXCLUDED.fine_amount
       RETURNING *;`,
      [userid, book_name, issue_date, return_date, fine_amount]
    );

    res.json({ message: "Book issued/updated successfully", book: result.rows[0] });
  } catch (err) {
    console.error("Error saving book:", err);
    res.status(500).json({ message: "Failed to save book" });
  }
});

// ✅ Delete/return a book for a student
app.delete("/api/library/book/:userid", async (req, res) => {
  const { userid } = req.params;
  try {
    const result = await pool.query("DELETE FROM books WHERE userid=$1 RETURNING *", [userid]);
    if (result.rows.length === 0) return res.status(404).json({ message: "No book found for this user" });
    res.json({ message: "Book returned successfully", deleted: result.rows[0] });
  } catch (err) {
    console.error("Error returning book:", err);
    res.status(500).json({ message: "Failed to return book" });
  }
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
// LOGIN ROUTE
// ============================
app.post("/api/login", async (req, res) => {
  const { userid, password } = req.body;

  if (!userid || !password) {
    return res.status(400).json({ message: "UserID and password are required" });
  }

  try {
    // 1️⃣ Check if credentials are valid in users table
    const userResult = await pool.query(
      "SELECT * FROM users WHERE userid=$1 AND password=$2",
      [userid, password]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 2️⃣ Check if userid exists in students table
    const studentResult = await pool.query(
      "SELECT * FROM students WHERE userid=$1",
      [userid]
    );

    if (studentResult.rows.length > 0) {
      // ✅ User exists in students → redirect to submit.html
      return res.json({
        status: "submit",
        userid,
        secretKey: studentResult.rows[0].secret_key || null
      });
    } else {
      // ❌ User does NOT exist in students → insert userid with secret_key
      const secretKey = uuidv4();

      await pool.query(
        "INSERT INTO students (userid, secret_key) VALUES ($1, $2)",
        [userid, secretKey]
      );

      // Redirect to ERP page
      return res.json({
        status: "erp",
        userid,
        secretKey
      });
    }
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// ============================
// 📌 Student Leave Routes
// ============================

// Student submits leave
app.post("/api/leaves", async (req, res) => {
  const { userid, name, leave_type, from_date, to_date, reason } = req.body;

  if (!userid || !name || !leave_type || !from_date || !to_date || !reason) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO leaves (userid, name, leave_type, from_date, to_date, reason, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
      [userid, name, leave_type, from_date, to_date, reason]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("Error inserting leave:", err);
    res.status(500).json({ message: "Failed to submit leave" });
  }
});

// Get all leave requests (Admin portal)
app.get("/api/leaves", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, userid, name, leave_type, from_date, to_date, reason, status FROM leaves ORDER BY id DESC"
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching leaves:", err);
    res.status(500).json({ message: "Failed to fetch leaves" });
  }
});

// Approve/Decline a leave (Admin)
app.put("/api/leaves/:id", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["approved", "declined"].includes(status)) {
    return res.status(400).json({ message: "Invalid status" });
  }

  try {
    const { rows } = await pool.query(
      "UPDATE leaves SET status=$1 WHERE id=$2 RETURNING *",
      [status, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "Leave not found" });
    }

    res.json({ message: `Leave ${status}`, leave: rows[0] });
  } catch (err) {
    console.error("Error updating leave:", err);
    res.status(500).json({ message: "Failed to update leave" });
  }
});

// Get leaves for a specific student
app.get("/api/leaves/:userid", async (req, res) => {
  const { userid } = req.params;
  try {
    const { rows } = await pool.query(
      "SELECT id, userid, name, leave_type, from_date, to_date, reason, status FROM leaves WHERE userid=$1 ORDER BY id DESC",
      [userid]
    );
    res.json(rows);
  } catch (err) {
    console.error("Error fetching student leaves:", err);
    res.status(500).json({ message: "Failed to fetch student leaves" });
  }
});




// Cloudinary setup
cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_API_KEY,
  api_secret: process.env.CLOUD_API_SECRET,
});



// ERP submission route
app.post("/api/students", upload.fields([
  { name: "profile_photo", maxCount: 1 },
  { name: "documents", maxCount: 1 },
]), async (req, res) => {
  try {
    const {
      userid,
      name,
      dob,
      gender,
      contact,
      category,
      address,
      parent_name,
      parent_contact
    } = req.body;

    if (!userid) return res.status(400).json({ message: "UserID is required" });

    // Get uploaded file URLs if present
    const profile_photo_url = req.files["profile_photo"]?.[0]?.path || null;
    const documents_url = req.files["documents"]?.[0]?.path || null;

    // Update existing student row for this userid
    const result = await pool.query(
      `UPDATE students SET
        name = $1,
        dob = $2,
        gender = $3,
        contact = $4,
        category = $5,
        address = $6,
        parent_name = $7,
        parent_contact = $8,
        profile_photo_url = COALESCE($9, profile_photo_url),
        documents_url = COALESCE($10, documents_url)
       WHERE userid = $11
       RETURNING *`,
      [
        name,
        dob,
        gender,
        contact,
        category,
        address,
        parent_name,
        parent_contact,
        profile_photo_url,
        documents_url,
        userid
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Student not found" });
    }

    console.log("ERP form updated:", result.rows[0]);
    res.json({ message: "ERP submitted successfully!", student: result.rows[0] });

  } catch (err) {
    console.error("ERP submission error:", err);
    res.status(500).json({ message: "Server error" });
  }
});


// Get student by userid
app.get("/api/students/:userid", async (req, res) => {
  const { userid } = req.params;
  try {
    const result = await pool.query("SELECT * FROM students WHERE userid=$1", [userid]);
    if (result.rows.length === 0) return res.status(404).json({ message: "Student not found" });

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});




// ============================
// Bulletin (lowercase columns)
// ============================

// ✅ GET all notices
app.get("/api/bulletin", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, category, date, content 
       FROM bulletin 
       ORDER BY date DESC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching notices:", err);
    res.status(500).json({ error: "Failed to fetch notices" });
  }
});

// ✅ POST a new notice
app.post("/api/bulletin", async (req, res) => {
  try {
    const { title, category, date, content } = req.body;
    const result = await pool.query(
      `INSERT INTO bulletin (title, category, date, content) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, title, category, date, content`,
      [title, category, date, content]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Error inserting notice:", err);
    res.status(500).json({ error: "Failed to add notice" });
  }
});

// ✅ UPDATE a notice
app.put("/api/bulletin/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { title, category, date, content } = req.body;

    const result = await pool.query(
      `UPDATE bulletin 
       SET title=$1, category=$2, date=$3, content=$4 
       WHERE id=$5 
       RETURNING id, title, category, date, content`,
      [title, category, date, content, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notice not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating notice:", err);
    res.status(500).json({ error: "Failed to update notice" });
  }
});

// ✅ DELETE a notice
app.delete("/api/bulletin/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM bulletin WHERE id=$1 RETURNING id`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Notice not found" });
    }

    res.json({ success: true, deletedId: id });
  } catch (err) {
    console.error("Error deleting notice:", err);
    res.status(500).json({ error: "Failed to delete notice" });
  }
});

// ✅ DELETE all notices
app.delete("/api/bulletin", async (req, res) => {
  try {
    await pool.query("DELETE FROM bulletin");
    res.json({ success: true, message: "All notices cleared" });
  } catch (err) {
    console.error("Error clearing notices:", err);
    res.status(500).json({ error: "Failed to clear notices" });
  }
});

// ============================
// Serve frontend
// ============================
// Serve frontend - default to student portal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "student", "index.html"));
});


// ============================
// Start server
// ============================
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));

