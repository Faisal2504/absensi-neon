import { NextResponse } from 'next/server';
import { sql } from '@/lib/db';

export async function GET() {
  try {
    const rows = await sql`
      SELECT id_log, TO_CHAR(tanggal, 'YYYY-MM-DD') AS tanggal, id_karyawan, nama,
             jenis, waktu_scan, jadwal_berangkat, telat_menit, status,
             koordinat_gps, jarak_meter, mode_rekam, qr_id
      FROM log_absensi
      ORDER BY created_at DESC
      LIMIT 500
    `;
    return NextResponse.json({ status: 'ok', data: rows });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'error', message: String(error) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
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
