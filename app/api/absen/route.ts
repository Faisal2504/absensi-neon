import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

async function ensureLogTable() {
  await sql`
    CREATE TABLE IF NOT EXISTS log_absensi (
      id_log VARCHAR(100) PRIMARY KEY,
      tanggal DATE NOT NULL,
      id_karyawan VARCHAR(50) NOT NULL,
      nama VARCHAR(100) NOT NULL,
      jenis VARCHAR(20) NOT NULL,
      waktu_scan VARCHAR(10) NOT NULL,
      jadwal_berangkat VARCHAR(10) NOT NULL,
      telat_menit INT DEFAULT 0,
      status VARCHAR(30) NOT NULL,
      koordinat_gps VARCHAR(60),
      jarak_meter INT DEFAULT 0,
      mode_rekam VARCHAR(20) DEFAULT 'Online',
      qr_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
}

export async function GET() {
  try {
    await ensureLogTable();
    const rows = await sql`
      SELECT id_log, TO_CHAR(tanggal, 'YYYY-MM-DD') AS tanggal, id_karyawan, nama,
             jenis, waktu_scan, jadwal_berangkat, telat_menit, status,
             koordinat_gps, jarak_meter, mode_rekam, qr_id
      FROM log_absensi
      ORDER BY tanggal DESC, waktu_scan DESC, created_at DESC
      LIMIT 500
    `;
    return NextResponse.json({ status: 'ok', data: rows });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    await ensureLogTable();
    const { records } = await req.json();
    for (const rec of records) {
      await sql`
        INSERT INTO log_absensi (
          id_log, tanggal, id_karyawan, nama, jenis, waktu_scan,
          jadwal_berangkat, telat_menit, status, koordinat_gps,
          jarak_meter, mode_rekam, qr_id
        ) VALUES (
          ${rec.id_log}, ${rec.tanggal}, ${rec.id_karyawan}, ${rec.nama},
          ${rec.jenis}, ${rec.waktu_scan}, ${rec.jadwal_berangkat},
          ${rec.telat_menit}, ${rec.status}, ${rec.koordinat_gps},
          ${rec.jarak_meter}, ${rec.mode_rekam}, ${rec.qr_id}
        )
        ON CONFLICT (id_log) DO NOTHING
      `;
    }
    return NextResponse.json({ status: 'ok', synced: records.length });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    await ensureLogTable();
    const body = await req.json();
    const id_log = String(body.id_log || '').trim();
    const jenis = body.jenis === 'KELUAR' ? 'KELUAR' : 'MASUK';
    const waktu_scan = String(body.waktu_scan || '').trim();
    const telat_menit = Number(body.telat_menit || 0);
    const status = String(body.status || '').trim();

    if (!id_log || !waktu_scan || !status) {
      return NextResponse.json({ status: 'error', message: 'Data edit tidak lengkap!' }, { status: 400 });
    }

    await sql`
      UPDATE log_absensi
      SET jenis = ${jenis},
          waktu_scan = ${waktu_scan},
          telat_menit = ${telat_menit},
          status = ${status}
      WHERE id_log = ${id_log}
    `;
    return NextResponse.json({ status: 'ok' });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    await ensureLogTable();
    const { searchParams } = new URL(req.url);
    const id_log = String(searchParams.get('id_log') || '').trim();
    if (!id_log) {
      return NextResponse.json({ status: 'error', message: 'ID log wajib diisi!' }, { status: 400 });
    }
    await sql`DELETE FROM log_absensi WHERE id_log = ${id_log}`;
    return NextResponse.json({ status: 'ok' });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}


