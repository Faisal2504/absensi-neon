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

const globalStore = globalThis as unknown as {
  __absensiStore?: {
    employees: EmployeeRecord[];
    locations: LocationRecord[];
    entries: PunchRecord[];
    initialized: boolean;
  };
};

function getStore() {
  if (!globalStore.__absensiStore) {
    globalStore.__absensiStore = {
      employees: [...INITIAL_EMPLOYEES],
      locations: [...INITIAL_LOCATIONS],
      entries: [],
      initialized: false,
    };
  }
  return globalStore.__absensiStore;
}

function getNeonHttpUrl(): string | null {
  const conn = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (!conn) return null;
  try {
    const u = new URL(conn);
    const host = u.hostname;
    const db = u.pathname.replace(/^\//, "") || "neondb";
    return `https://${host}/sql?database=${encodeURIComponent(db)}`;
  } catch {
    return null;
  }
}

async function runNeonSql(
  query: string,
  params: unknown[] = []
): Promise<{ ok: boolean; rows: Record<string, unknown>[] }> {
  const endpoint = getNeonHttpUrl();
  const conn = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
  if (!endpoint || !conn) return { ok: false, rows: [] };

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": conn,
        "Neon-Raw-Text-Output": "false",
      },
      body: JSON.stringify({ query, params }),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, rows: [] };
    const data = await res.json();
    const rows = Array.isArray(data?.rows) ? data.rows : [];
    return { ok: true, rows };
  } catch {
    return { ok: false, rows: [] };
  }
}

async function ensureNeonTables(): Promise<boolean> {
  const store = getStore();
  const check = await runNeonSql(`
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
  if (!check.ok) return false;

  await runNeonSql(`
    CREATE TABLE IF NOT EXISTS locations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL DEFAULT 'Kantor Utama',
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      radius_meters INTEGER NOT NULL DEFAULT 2000
    );
  `);

  await runNeonSql(`
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

  if (!store.initialized) {
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

    const locCount = await runNeonSql(`SELECT COUNT(*)::int AS cnt FROM locations;`);
    if (Number(locCount.rows[0]?.cnt ?? 0) === 0) {
      await runNeonSql(
        `INSERT INTO locations (name, latitude, longitude, radius_meters) VALUES ($1, $2, $3, $4);`,
        ["Kantor Utama", DEFAULT_LAT, DEFAULT_LNG, DEFAULT_RADIUS]
      );
    }
    store.initialized = true;
  }

  return true;
}

export async function GET() {
  const store = getStore();
  const dbReady = await ensureNeonTables();

  if (dbReady) {
    const [empRes, locRes, entryRes] = await Promise.all([
      runNeonSql(`SELECT * FROM employees ORDER BY id ASC;`),
      runNeonSql(`SELECT * FROM locations ORDER BY id ASC LIMIT 1;`),
      runNeonSql(`SELECT * FROM time_entries ORDER BY punched_at DESC LIMIT 300;`),
    ]);

    if (empRes.ok && empRes.rows.length > 0) {
      store.employees = empRes.rows.map((r, idx) => ({
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
      }));
    }

    if (locRes.ok && locRes.rows.length > 0) {
      const l = locRes.rows[0];
      store.locations = [
        {
          id: Number(l.id) || 1,
          name: String(l.name || "Kantor Utama"),
          latitude: Number(l.latitude) || DEFAULT_LAT,
          longitude: Number(l.longitude) || DEFAULT_LNG,
          radius_meters: Math.max(10, Number(l.radius_meters) || DEFAULT_RADIUS),
        },
      ];
    }

    if (entryRes.ok) {
      store.entries = entryRes.rows.map((item, idx) => ({
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
      }));
    }
  }

  return NextResponse.json({
    ok: true,
    serverTime: new Date().toISOString(),
    employees: store.employees,
    locations: store.locations,
    entries: store.entries,
    dbConnected: dbReady,
  });
}

export async function POST(req: NextRequest) {
  try {
    const store = getStore();
    const dbReady = await ensureNeonTables();
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
        const normalized: PunchRecord = {
          client_uuid: String(p.client_uuid),
          employee_id: Number(p.employee_id) || 3,
          emp_code: p.emp_code ? String(p.emp_code) : null,
          full_name: p.full_name ? String(p.full_name) : null,
          entry_type:
            String(p.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
              ? "CLOCK_OUT"
              : "CLOCK_IN",
          punched_at: p.punched_at
            ? new Date(p.punched_at).toISOString()
            : new Date().toISOString(),
          is_offline_sync: Boolean(p.is_offline_sync),
          qr_code: p.qr_code ? String(p.qr_code) : null,
          mode: String(p.mode || "BARCODE + WAJAH"),
          notes: String(p.notes || ""),
          latitude:
            p.latitude !== undefined && p.latitude !== null
              ? Number(p.latitude)
              : null,
          longitude:
            p.longitude !== undefined && p.longitude !== null
              ? Number(p.longitude)
              : null,
          distance_meters:
            p.distance_meters !== undefined && p.distance_meters !== null
              ? Number(p.distance_meters)
              : 0,
          is_within_geofence:
            p.is_within_geofence !== undefined
              ? Boolean(p.is_within_geofence)
              : true,
          selfie_data: p.selfie_data ? String(p.selfie_data) : null,
          face_detected: Boolean(p.face_detected),
        };

        const idxExisting = store.entries.findIndex(
          (x) => x.client_uuid === normalized.client_uuid
        );
        if (idxExisting >= 0) {
          store.entries[idxExisting] = {
            ...store.entries[idxExisting],
            ...normalized,
          };
        } else {
          store.entries.unshift(normalized);
        }

        if (dbReady) {
          await runNeonSql(
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
              normalized.client_uuid,
              normalized.employee_id,
              normalized.emp_code,
              normalized.full_name,
              normalized.entry_type,
              normalized.punched_at,
              normalized.is_offline_sync,
              normalized.qr_code,
              normalized.mode,
              normalized.notes,
              normalized.latitude,
              normalized.longitude,
              normalized.distance_meters,
              normalized.is_within_geofence,
              normalized.selfie_data,
              normalized.face_detected,
            ]
          );
        }

        syncedCount++;
      }

      return NextResponse.json({
        ok: true,
        syncedCount,
        entries: store.entries,
        dbConnected: dbReady,
      });
    }

    if (action === "UPDATE_ENTRY") {
      const p = body?.payload || {};
      const nextIso = p.punched_at
        ? new Date(p.punched_at).toISOString()
        : new Date().toISOString();
      const nextType: "CLOCK_IN" | "CLOCK_OUT" =
        String(p.entry_type || "CLOCK_IN").toUpperCase() === "CLOCK_OUT"
          ? "CLOCK_OUT"
          : "CLOCK_IN";
      const nextNotes = String(p.notes || "");

      store.entries = store.entries.map((x) =>
        x.client_uuid === p.client_uuid || (p.id && x.id === Number(p.id))
          ? { ...x, entry_type: nextType, punched_at: nextIso, notes: nextNotes }
          : x
      );

      if (dbReady) {
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
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_ENTRY") {
      const p = body?.payload || {};
      store.entries = store.entries.filter(
        (x) =>
          x.client_uuid !== p.client_uuid && (!p.id || x.id !== Number(p.id))
      );

      if (dbReady) {
        if (p.client_uuid) {
          await runNeonSql(`DELETE FROM time_entries WHERE client_uuid = $1;`, [
            String(p.client_uuid),
          ]);
        } else if (p.id) {
          await runNeonSql(`DELETE FROM time_entries WHERE id = $1;`, [
            Number(p.id),
          ]);
        }
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "SAVE_EMPLOYEE") {
      const p = body?.payload || {};
      const empCode = String(p.emp_code || "").trim();
      const fullName = String(p.full_name || "").trim();
      const role: "ADMIN" | "MANAGER" | "STAFF" =
        String(p.role || "STAFF").toUpperCase() === "ADMIN"
          ? "ADMIN"
          : String(p.role || "STAFF").toUpperCase() === "MANAGER"
          ? "MANAGER"
          : "STAFF";
      const department = String(p.department || "Operasional").trim();
      const pinCode = String(p.pin_code || "1111").trim();
      const shiftTime = String(p.shift_start_time || "07.00").trim();

      if (p.id) {
        store.employees = store.employees.map((e) =>
          e.id === Number(p.id)
            ? {
                ...e,
                emp_code: empCode,
                full_name: fullName,
                role,
                department,
                pin_code: pinCode,
                shift_start_time: shiftTime,
              }
            : e
        );
        if (dbReady) {
          await runNeonSql(
            `UPDATE employees SET emp_code = $1, full_name = $2, role = $3, department = $4, pin_code = $5, shift_start_time = $6 WHERE id = $7;`,
            [empCode, fullName, role, department, pinCode, shiftTime, Number(p.id)]
          );
        }
      } else {
        const exists = store.employees.findIndex(
          (e) => e.emp_code.toLowerCase() === empCode.toLowerCase()
        );
        if (exists >= 0) {
          store.employees[exists] = {
            ...store.employees[exists],
            emp_code: empCode,
            full_name: fullName,
            role,
            department,
            pin_code: pinCode,
            shift_start_time: shiftTime,
          };
        } else {
          store.employees.push({
            id: Date.now(),
            emp_code: empCode,
            full_name: fullName,
            role,
            department,
            pin_code: pinCode,
            shift_start_time: shiftTime,
          });
        }
        if (dbReady) {
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
      }
      return NextResponse.json({ ok: true });
    }

    if (action === "DELETE_EMPLOYEE") {
      const id = Number(body?.payload?.id);
      store.employees = store.employees.filter((e) => e.id !== id);
      if (dbReady && id) {
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

      store.locations = [
        {
          id: store.locations[0]?.id || 1,
          name,
          latitude: lat,
          longitude: lng,
          radius_meters: rad,
        },
      ];

      if (dbReady) {
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
      { ok: false, error: "Gagal memproses data absen" },
      { status: 500 }
    );
  }
}
