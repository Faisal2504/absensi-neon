import { NextRequest, NextResponse } from "next/server";
import { Pool } from "pg";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const globalForPg = globalThis as unknown as { pgPool?: Pool };

function getPool(): Pool | null {
  const connStr = process.env.DATABASE_URL;
  if (!connStr) return null;
  if (!globalForPg.pgPool) {
    globalForPg.pgPool = new Pool({
      connectionString: connStr,
      ssl: { rejectUnauthorized: false },
    });
  }
  return globalForPg.pgPool;
}

const DEFAULT_LAT = -6.9148609;
const DEFAULT_LNG = 109.744683;
const DEFAULT_RADIUS = 150;

const SEED_EMPLOYEES = [
  {
    id: 1,
    emp_code: "ADM-001",
    full_name: "Admin Operasional",
    role: "ADMIN",
    department: "Administrator",
    pin_code: "0000",
    shift_start_time: "07.00",
  },
  {
    id: 2,
    emp_code: "MGR-001",
    full_name: "Manager Operasional",
    role: "MANAGER",
    department: "Manajemen",
    pin_code: "2026",
    shift_start_time: "07.00",
  },
  {
    id: 3,
    emp_code: "ABZ-0001",
    full_name: "Amelia",
    role: "STAFF",
    department: "Operasional",
    pin_code: "1111",
    shift_start_time: "07.00",
  },
];

async function ensureSchema(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id SERIAL PRIMARY KEY,
      emp_code VARCHAR(32) UNIQUE NOT NULL,
      full_name VARCHAR(120) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'STAFF',
      department VARCHAR(80) NOT NULL DEFAULT 'Operasional',
      pin_code VARCHAR(20) NOT NULL DEFAULT '1111',
      shift_start_time VARCHAR(16) NOT NULL DEFAULT '07.00'
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL DEFAULT 'Kantor Utama',
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 2000
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS time_entries (
      id SERIAL PRIMARY KEY,
      client_uuid VARCHAR(100) UNIQUE NOT NULL,
      employee_id INTEGER NOT NULL,
      emp_code VARCHAR(32),
      full_name VARCHAR(120),
      entry_type VARCHAR(20) NOT NULL DEFAULT 'CLOCK_IN',
      punched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      is_offline_sync BOOLEAN NOT NULL DEFAULT FALSE,
      qr_code VARCHAR(100),
      mode VARCHAR(40) DEFAULT 'BARCODE + WAJAH',
      notes TEXT DEFAULT '',
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      distance_meters INTEGER DEFAULT 0,
      is_within_geofence BOOLEAN DEFAULT TRUE,
      selfie_data TEXT,
      face_detected BOOLEAN DEFAULT FALSE
    );
  `);

  for (const emp of SEED_EMPLOYEES) {
    await pool.query(
      `
      INSERT INTO employees (emp_code, full_name, role, department, pin_code, shift_start_time)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (emp_code) DO NOTHING;
      `,
      [
        emp.emp_code,
        emp.full_name,
        emp.role,
        emp.department,
        emp.pin_code,
        emp.shift_start_time,
      ]
    );
  }

  const locRes = await pool.query(`SELECT COUNT(*)::int AS cnt FROM locations;`);
  if ((locRes.rows[0]?.cnt ?? 0) === 0) {
    await pool.query(
      `
      INSERT INTO locations (name, latitude, longitude, radius_meters)
      VALUES ($1, $2, $3, $4);
      `,
      ["Kantor Utama", DEFAULT_LAT, DEFAULT_LNG, DEFAULT_RADIUS]
    );
  }
}

export async function GET() {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json({
      ok: true,
      serverTime: new Date().toISOString(),
      employees: SEED_EMPLOYEES,
      locations: [
        {
          id: 1,
          name: "Kantor Utama",
          latitude: DEFAULT_LAT,
          longitude: DEFAULT_LNG,
          radius_meters: DEFAULT_RADIUS,
        },
      ],
      entries: [],
      dbConnected: false,
    });
  }

  try {
    await ensureSchema(pool);
    const [empRes, locRes, entryRes] = await Promise.all([
      pool.query(`SELECT * FROM employees ORDER BY id ASC;`),
      pool.query(`SELECT * FROM locations ORDER BY id ASC LIMIT 1;`),
      pool.query(`SELECT * FROM time_entries ORDER BY punched_at DESC LIMIT 300;`),
    ]);

    return NextResponse.json({
      ok: true,
      serverTime: new Date().toISOString(),
      employees: empRes.rows,
      locations: locRes.rows.length > 0 ? locRes.rows : [
        {
          id: 1,
          name: "Kantor Utama",
          latitude: DEFAULT_LAT,
          longitude: DEFAULT_LNG,
          radius_meters: DEFAULT_RADIUS,
        },
      ],
      entries: entryRes.rows,
      dbConnected: true,
    });
  } catch (err) {
    console.error("GET /api/absensi error:", err);
    return NextResponse.json(
      { ok: false, error: "Gagal membaca database Neon" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  const pool = getPool();
  if (!pool) {
    return NextResponse.json(
      { ok: false, error: "DATABASE_URL belum dikonfigurasi di Vercel" },
      { status: 500 }
    );
  }

  try {
    await ensureSchema(pool);
    const body = await req.json();
    const action = String(body?.action || "SUBMIT_PUNCH").toUpperCase();

    if (action === "SUBMIT_PUNCH" || action === "SYNC_PUNCHES") {
      const punches = Array.isArray(body?.punches)
        ? body.punches
        : body?.punch
        ? [body.punch]
        : [];

      let syncedCount = 0;
      for (const p of punches) {
        if (!p?.client_uuid) continue;
        const empId = Number(p.employee_id) || 3;
        const entryType =
          String(p.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
            ? "CLOCK_OUT"
            : "CLOCK_IN";
        const punchedAt = p.punched_at
          ? new Date(p.punched_at).toISOString()
          : new Date().toISOString();

        await pool.query(
          `
          INSERT INTO time_entries (
            client_uuid, employee_id, emp_code, full_name, entry_type,
            punched_at, is_offline_sync, qr_code, mode, notes,
            latitude, longitude, distance_meters, is_within_geofence,
            selfie_data, face_detected
          )
          VALUES (
            $1, $2, $3, $4, $5,
            $6::timestamptz, $7, $8, $9, $10,
            $11, $12, $13, $14,
            $15, $16
          )
          ON CONFLICT (client_uuid) DO UPDATE SET
            entry_type = EXCLUDED.entry_type,
            punched_at = EXCLUDED.punched_at,
            is_offline_sync = EXCLUDED.is_offline_sync,
            qr_code = EXCLUDED.qr_code,
            mode = EXCLUDED.mode,
            latitude = EXCLUDED.latitude,
            longitude = EXCLUDED.longitude,
            distance_meters = EXCLUDED.distance_meters,
            is_within_geofence = EXCLUDED.is_within_geofence,
            selfie_data = COALESCE(EXCLUDED.selfie_data, time_entries.selfie_data),
            face_detected = EXCLUDED.face_detected;
          `,
          [
            String(p.client_uuid),
            empId,
            p.emp_code ? String(p.emp_code) : null,
            p.full_name ? String(p.full_name) : null,
            entryType,
            punchedAt,
            Boolean(p.is_offline_sync),
            p.qr_code ? String(p.qr_code) : null,
            p.mode ? String(p.mode) : "BARCODE + WAJAH",
            p.notes ? String(p.notes) : "",
            p.latitude !== undefined && p.latitude !== null
              ? Number(p.latitude)
              : null,
            p.longitude !== undefined && p.longitude !== null
              ? Number(p.longitude)
              : null,
            p.distance_meters !== undefined && p.distance_meters !== null
              ? Number(p.distance_meters)
              : 0,
            p.is_within_geofence !== undefined
              ? Boolean(p.is_within_geofence)
              : true,
            p.selfie_data ? String(p.selfie_data) : null,
            Boolean(p.face_detected),
          ]
        );
        syncedCount++;
      }

      const entryRes = await pool.query(
        `SELECT * FROM time_entries ORDER BY punched_at DESC LIMIT 300;`
      );
      return NextResponse.json({
        ok: true,
        syncedCount,
        entries: entryRes.rows,
      });
    }

    if (action === "UPDATE_ENTRY") {
      const p = body?.payload || {};
      const nextIso = p.punched_at
        ? new Date(p.punched_at).toISOString()
        : new Date().toISOString();
      const nextType =
        String(p.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
          ? "CLOCK_OUT"
          : "CLOCK_IN";

      if (p.client_uuid) {
        await pool.query(
          `
          UPDATE time_entries
          SET entry_type = $1, punched_at = $2::timestamptz, notes = $3
          WHERE client_uuid = $4;
          `,
          [nextType, nextIso, String(p.notes || ""), String(p.client_uuid)]
        );
      } else if (p.id) {
        await pool.query(
          `
          UPDATE time_entries
          SET entry_type = $1, punched_at = $2::timestamptz, notes = $3
          WHERE id = $4;
          `,
          [nextType, nextIso, String(p.notes || ""), Number(p.id)]
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_ENTRY") {
      const p = body?.payload || {};
      if (p.client_uuid) {
        await pool.query(`DELETE FROM time_entries WHERE client_uuid = $1;`, [
          String(p.client_uuid),
        ]);
      } else if (p.id) {
        await pool.query(`DELETE FROM time_entries WHERE id = $1;`, [
          Number(p.id),
        ]);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_EMPLOYEE") {
      const p = body?.payload || {};
      if (p.id) {
        await pool.query(
          `
          UPDATE employees
          SET emp_code = $1, full_name = $2, role = $3, department = $4, pin_code = $5, shift_start_time = $6
          WHERE id = $7;
          `,
          [
            String(p.emp_code).trim(),
            String(p.full_name).trim(),
            String(p.role || "STAFF").toUpperCase(),
            String(p.department || "Operasional").trim(),
            String(p.pin_code || "1111").trim(),
            String(p.shift_start_time || "07.00").trim(),
            Number(p.id),
          ]
        );
      } else {
        await pool.query(
          `
          INSERT INTO employees (emp_code, full_name, role, department, pin_code, shift_start_time)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (emp_code) DO UPDATE SET
            full_name = EXCLUDED.full_name,
            role = EXCLUDED.role,
            department = EXCLUDED.department,
            pin_code = EXCLUDED.pin_code,
            shift_start_time = EXCLUDED.shift_start_time;
          `,
          [
            String(p.emp_code).trim(),
            String(p.full_name).trim(),
            String(p.role || "STAFF").toUpperCase(),
            String(p.department || "Operasional").trim(),
            String(p.pin_code || "1111").trim(),
            String(p.shift_start_time || "07.00").trim(),
          ]
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_EMPLOYEE") {
      const id = Number(body?.payload?.id);
      if (id) {
        await pool.query(`DELETE FROM employees WHERE id = $1;`, [id]);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_LOCATION") {
      const p = body?.payload || {};
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      const rad = Math.max(10, Number(p.radius_meters) || DEFAULT_RADIUS);
      const name = String(p.name || "Kantor Utama");

      const existing = await pool.query(`SELECT id FROM locations ORDER BY id ASC LIMIT 1;`);
      if (existing.rows.length > 0) {
        await pool.query(
          `
          UPDATE locations
          SET name = $1, latitude = $2, longitude = $3, radius_meters = $4
          WHERE id = $5;
          `,
          [name, lat, lng, rad, Number(existing.rows[0].id)]
        );
      } else {
        await pool.query(
          `
          INSERT INTO locations (name, latitude, longitude, radius_meters)
          VALUES ($1, $2, $3, $4);
          `,
          [name, lat, lng, rad]
        );
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { ok: false, error: "Aksi tidak dikenali" },
      { status: 400 }
    );
  } catch (err) {
    console.error("POST /api/absensi error:", err);
    return NextResponse.json(
      { ok: false, error: "Gagal menyimpan data ke database Neon" },
      { status: 500 }
    );
  }
}
