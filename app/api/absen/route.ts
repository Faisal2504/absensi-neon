import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface EmployeeRecord {
  id: number;
  emp_code: string;
  full_name: string;
  role: "ADMIN" | "MANAGER" | "STAFF";
  department: string;
  pin_code: string;
  shift_start_time: string;
}

export interface LocationRecord {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  radius_meters: number;
}

export interface PunchRecord {
  id?: number;
  client_uuid: string;
  employee_id: number;
  emp_code?: string | null;
  full_name?: string | null;
  entry_type: "CLOCK_IN" | "CLOCK_OUT";
  punched_at: string;
  is_offline_sync?: boolean;
  qr_code?: string | null;
  mode?: string;
  notes?: string;
  latitude?: number | null;
  longitude?: number | null;
  distance_meters?: number | null;
  is_within_geofence?: boolean;
  selfie_data?: string | null;
  face_detected?: boolean;
}

const DEFAULT_LAT = -6.9148609;
const DEFAULT_LNG = 109.744683;
const DEFAULT_RADIUS = 2000;

const INITIAL_EMPLOYEES: EmployeeRecord[] = [
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

const INITIAL_LOCATIONS: LocationRecord[] = [
  {
    id: 1,
    name: "Kantor Utama",
    latitude: DEFAULT_LAT,
    longitude: DEFAULT_LNG,
    radius_meters: DEFAULT_RADIUS,
  },
];

function findDatabaseUrl(): { envKey: string; url: string } | null {
  const keys = [
    "DATABASE_URL",
    "DATABASE_URL_UNPOOLED",
    "POSTGRES_URL",
    "POSTGRES_PRISMA_URL",
    "POSTGRES_URL_NON_POOLING",
    "NEON_DATABASE_URL",
  ];
  for (const k of keys) {
    const val = (process.env[k] || "").trim();
    if (val) {
      return {
        envKey: k,
        url: val.replace(/^postgres:\/\//i, "postgresql://"),
      };
    }
  }
  return null;
}

function getNeonConfig(): {
  envKey: string;
  endpoint: string;
  conn: string;
} | null {
  const found = findDatabaseUrl();
  if (!found) return null;
  try {
    const u = new URL(found.url);
    return {
      envKey: found.envKey,
      endpoint: `https://${u.hostname}/sql`,
      conn: found.url,
    };
  } catch {
    return null;
  }
}

async function runNeonSql(
  query: string,
  params: unknown[] = []
): Promise<{ ok: boolean; rows: Record<string, unknown>[]; error?: string }> {
  const cfg = getNeonConfig();
  if (!cfg) {
    return {
      ok: false,
      rows: [],
      error: "DATABASE_URL tidak ditemukan di Environment Variables Vercel",
    };
  }

  try {
    const res = await fetch(cfg.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": cfg.conn,
      },
      body: JSON.stringify({ query, params }),
      cache: "no-store",
    });

    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        rows: [],
        error: `Neon HTTP ${res.status} (${cfg.envKey}): ${text.slice(0, 200)}`,
      };
    }

    const data = JSON.parse(text);
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return { ok: true, rows };
  } catch (err) {
    return {
      ok: false,
      rows: [],
      error: err instanceof Error ? err.message : "Gagal terhubung ke Neon",
    };
  }
}

async function ensureNeonTables(): Promise<{ ok: boolean; error?: string }> {
  const t1 = await runNeonSql(`
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
  if (!t1.ok) return { ok: false, error: t1.error };

  const t2 = await runNeonSql(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL DEFAULT 'Kantor Utama',
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 2000
    );
  `);
  if (!t2.ok) return { ok: false, error: t2.error };

  const t3 = await runNeonSql(`
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
  if (!t3.ok) return { ok: false, error: t3.error };

  const empCount = await runNeonSql(`SELECT COUNT(*)::int AS cnt FROM employees;`);
  if (empCount.ok && Number(empCount.rows[0]?.cnt ?? 0) === 0) {
    for (const emp of INITIAL_EMPLOYEES) {
      await runNeonSql(
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
  }

  const locCount = await runNeonSql(`SELECT COUNT(*)::int AS cnt FROM locations;`);
  if (locCount.ok && Number(locCount.rows[0]?.cnt ?? 0) === 0) {
    await runNeonSql(
      `INSERT INTO locations (name, latitude, longitude, radius_meters) VALUES ($1, $2, $3, $4);`,
      ["Kantor Utama", DEFAULT_LAT, DEFAULT_LNG, DEFAULT_RADIUS]
    );
  }

  return { ok: true };
}

export async function GET(req: NextRequest) {
  const isDiag = req.nextUrl.searchParams.get("diag") === "1";
  const cfg = getNeonConfig();
  const schema = await ensureNeonTables();

  if (!schema.ok) {
    return NextResponse.json({
      ok: true,
      dbConnected: false,
      dbError: schema.error,
      envKeyUsed: cfg?.envKey || null,
      serverTime: new Date().toISOString(),
      employees: INITIAL_EMPLOYEES,
      locations: INITIAL_LOCATIONS,
      entries: [],
    });
  }

  const [empRes, locRes, entryRes] = await Promise.all([
    runNeonSql(`SELECT * FROM employees ORDER BY id ASC;`),
    runNeonSql(`SELECT * FROM locations ORDER BY id ASC LIMIT 1;`),
    runNeonSql(`SELECT * FROM time_entries ORDER BY punched_at DESC LIMIT 300;`),
  ]);

  const employees: EmployeeRecord[] =
    empRes.ok && empRes.rows.length > 0
      ? empRes.rows.map((r, idx) => ({
          id: Number(r.id) || idx + 1,
          emp_code: String(r.emp_code || `EMP-${idx + 1}`),
          full_name: String(r.full_name || "Karyawan"),
          role:
            String(r.role || "STAFF").toUpperCase() === "ADMIN"
              ? "ADMIN"
              : String(r.role || "STAFF").toUpperCase() === "MANAGER"
              ? "MANAGER"
              : "STAFF",
          department: String(r.department || "Operasional"),
          pin_code: String(r.pin_code || "1111"),
          shift_start_time: String(r.shift_start_time || "07.00"),
        }))
      : INITIAL_EMPLOYEES;

  const locations: LocationRecord[] =
    locRes.ok && locRes.rows.length > 0
      ? [
          {
            id: Number(locRes.rows[0].id) || 1,
            name: String(locRes.rows[0].name || "Kantor Utama"),
            latitude: Number(locRes.rows[0].latitude) || DEFAULT_LAT,
            longitude: Number(locRes.rows[0].longitude) || DEFAULT_LNG,
            radius_meters: Math.max(
              10,
              Number(locRes.rows[0].radius_meters) || DEFAULT_RADIUS
            ),
          },
        ]
      : INITIAL_LOCATIONS;

  const entries: PunchRecord[] = entryRes.ok
    ? entryRes.rows.map((item, idx) => ({
        id: Number(item.id) || idx + 1,
        client_uuid: String(item.client_uuid || `db-${idx + 1}`),
        employee_id: Number(item.employee_id) || 3,
        emp_code: item.emp_code ? String(item.emp_code) : null,
        full_name: item.full_name ? String(item.full_name) : null,
        entry_type:
          String(item.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
            ? "CLOCK_OUT"
            : "CLOCK_IN",
        punched_at: item.punched_at
          ? new Date(String(item.punched_at)).toISOString()
          : new Date().toISOString(),
        is_offline_sync: Boolean(item.is_offline_sync),
        qr_code: item.qr_code ? String(item.qr_code) : null,
        mode: String(item.mode || "BARCODE + WAJAH"),
        notes: String(item.notes || ""),
        latitude:
          item.latitude !== null && item.latitude !== undefined
            ? Number(item.latitude)
            : null,
        longitude:
          item.longitude !== null && item.longitude !== undefined
            ? Number(item.longitude)
            : null,
        distance_meters:
          item.distance_meters !== null && item.distance_meters !== undefined
            ? Number(item.distance_meters)
            : 0,
        is_within_geofence:
          item.is_within_geofence !== undefined
            ? Boolean(item.is_within_geofence)
            : true,
        selfie_data: item.selfie_data ? String(item.selfie_data) : null,
        face_detected: Boolean(item.face_detected),
      }))
    : [];

  return NextResponse.json({
    ok: true,
    dbConnected: true,
    envKeyUsed: cfg?.envKey || null,
    serverTime: new Date().toISOString(),
    employees,
    locations,
    entries,
    ...(isDiag
      ? {
          diag: {
            endpoint: cfg?.endpoint || null,
            entriesInDb: entries.length,
            employeesInDb: employees.length,
          },
        }
      : {}),
  });
}

export async function POST(req: NextRequest) {
  try {
    const schema = await ensureNeonTables();
    if (!schema.ok) {
      return NextResponse.json(
        {
          ok: false,
          dbConnected: false,
          error: schema.error || "Database Neon belum terhubung",
        },
        { status: 500 }
      );
    }

    const body = await req.json();
    const action = String(body?.action || "SUBMIT_PUNCH").toUpperCase();

    if (action === "SUBMIT_PUNCH" || action === "SYNC_PUNCHES") {
      const punches: PunchRecord[] = Array.isArray(body?.punches)
        ? body.punches
        : body?.punch
        ? [body.punch]
        : [];

      let syncedCount = 0;
      for (const p of punches) {
        if (!p?.client_uuid) continue;
        const entryType =
          String(p.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
            ? "CLOCK_OUT"
            : "CLOCK_IN";
        const parsedDate = p.punched_at ? new Date(p.punched_at) : new Date();
        const punchedAt = isNaN(parsedDate.getTime())
          ? new Date().toISOString()
          : parsedDate.toISOString();

        const ins = await runNeonSql(
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
            Math.max(1, Number(p.employee_id) || 3),
            p.emp_code ? String(p.emp_code) : null,
            p.full_name ? String(p.full_name) : null,
            entryType,
            punchedAt,
            Boolean(p.is_offline_sync),
            p.qr_code ? String(p.qr_code) : null,
            String(p.mode || "BARCODE + WAJAH"),
            String(p.notes || ""),
            p.latitude !== undefined &&
            p.latitude !== null &&
            !Number.isNaN(Number(p.latitude))
              ? Number(p.latitude)
              : null,
            p.longitude !== undefined &&
            p.longitude !== null &&
            !Number.isNaN(Number(p.longitude))
              ? Number(p.longitude)
              : null,
            p.distance_meters !== undefined &&
            p.distance_meters !== null &&
            !Number.isNaN(Number(p.distance_meters))
              ? Math.round(Number(p.distance_meters))
              : 0,
            p.is_within_geofence !== undefined
              ? Boolean(p.is_within_geofence)
              : true,
            p.selfie_data ? String(p.selfie_data) : null,
            Boolean(p.face_detected),
          ]
        );

        if (!ins.ok) {
          return NextResponse.json(
            { ok: false, error: ins.error || "Gagal INSERT ke Neon" },
            { status: 500 }
          );
        }
        syncedCount++;
      }

      const entryRes = await runNeonSql(
        `SELECT * FROM time_entries ORDER BY punched_at DESC LIMIT 300;`
      );
      return NextResponse.json({
        ok: true,
        dbConnected: true,
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
      const nextNotes = String(p.notes || "");

      if (p.client_uuid) {
        await runNeonSql(
          `UPDATE time_entries SET entry_type = $1, punched_at = $2::timestamptz, notes = $3 WHERE client_uuid = $4;`,
          [nextType, nextIso, nextNotes, String(p.client_uuid)]
        );
      } else if (p.id) {
        await runNeonSql(
          `UPDATE time_entries SET entry_type = $1, punched_at = $2::timestamptz, notes = $3 WHERE id = $4;`,
          [nextType, nextIso, nextNotes, Number(p.id)]
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_ENTRY") {
      const p = body?.payload || {};
      if (p.client_uuid) {
        await runNeonSql(`DELETE FROM time_entries WHERE client_uuid = $1;`, [
          String(p.client_uuid),
        ]);
      } else if (p.id) {
        await runNeonSql(`DELETE FROM time_entries WHERE id = $1;`, [
          Number(p.id),
        ]);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_EMPLOYEE") {
      const p = body?.payload || {};
      const empCode = String(p.emp_code || "").trim();
      const fullName = String(p.full_name || "").trim();
      const role =
        String(p.role || "STAFF").toUpperCase() === "ADMIN"
          ? "ADMIN"
          : String(p.role || "STAFF").toUpperCase() === "MANAGER"
          ? "MANAGER"
          : "STAFF";
      const department = String(p.department || "Operasional").trim();
      const pinCode = String(p.pin_code || "1111").trim();
      const shiftTime = String(p.shift_start_time || "07.00").trim();

      if (p.id) {
        await runNeonSql(
          `UPDATE employees SET emp_code = $1, full_name = $2, role = $3, department = $4, pin_code = $5, shift_start_time = $6 WHERE id = $7;`,
          [empCode, fullName, role, department, pinCode, shiftTime, Number(p.id)]
        );
      } else {
        await runNeonSql(
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
          [empCode, fullName, role, department, pinCode, shiftTime]
        );
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_EMPLOYEE") {
      const id = Number(body?.payload?.id);
      if (id) {
        await runNeonSql(`DELETE FROM employees WHERE id = $1;`, [id]);
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_LOCATION") {
      const p = body?.payload || {};
      const lat = Number(p.latitude);
      const lng = Number(p.longitude);
      const rad = Math.max(10, Number(p.radius_meters) || DEFAULT_RADIUS);
      const name = String(p.name || "Kantor Utama");

      const existing = await runNeonSql(
        `SELECT id FROM locations ORDER BY id ASC LIMIT 1;`
      );
      if (existing.rows.length > 0) {
        await runNeonSql(
          `UPDATE locations SET name = $1, latitude = $2, longitude = $3, radius_meters = $4 WHERE id = $5;`,
          [name, lat, lng, rad, Number(existing.rows[0].id)]
        );
      } else {
        await runNeonSql(
          `INSERT INTO locations (name, latitude, longitude, radius_meters) VALUES ($1, $2, $3, $4);`,
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
    console.error("POST /api/absen error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Gagal memproses data absen",
      },
      { status: 500 }
    );
  }
}
