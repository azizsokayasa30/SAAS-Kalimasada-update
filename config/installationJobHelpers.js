const MARKER = '[Selesai — app teknisi]';

/**
 * Ambil ringkasan penyelesaian dari catatan job + kolom koordinat teknisi.
 */
function extractTechnicianInstallCompletion(job) {
  if (!job) {
    return {
      description: null,
      photoPath: null,
      lat: null,
      lng: null,
      cableLengthM: null,
      stickerPhotoPath: null
    };
  }
  const text = typeof job.notes === 'string' ? job.notes : '';
  const idx = text.lastIndexOf(MARKER);
  let description = null;
  let photoPath = null;
  let stickerFromNotes = null;
  if (idx !== -1) {
    const block = text.slice(idx + MARKER.length).trim();
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length);
    const descParts = [];
    for (const line of lines) {
      if (line.startsWith('📷 Stiker ONT:')) {
        const sm = line.match(/(\/img\/field-completion\/[^\s]+\.(?:jpg|jpeg|png|webp))/i);
        if (sm) stickerFromNotes = sm[1];
        continue;
      }
      if (line.startsWith('📏')) continue;
      const imgMatch = line.match(/(\/img\/field-completion\/[^\s]+\.(?:jpg|jpeg|png|webp))/i);
      if (imgMatch) {
        photoPath = imgMatch[1];
        continue;
      }
      if (line.startsWith('📷')) {
        const m2 = line.match(/(\/img\/[^\s]+)/);
        if (m2) photoPath = m2[1];
        continue;
      }
      descParts.push(line);
    }
    description = descParts.join('\n').trim() || null;
  }
  const lat =
    job.tech_completion_latitude != null && job.tech_completion_latitude !== ''
      ? Number(job.tech_completion_latitude)
      : null;
  const lng =
    job.tech_completion_longitude != null && job.tech_completion_longitude !== ''
      ? Number(job.tech_completion_longitude)
      : null;
  const cableCol =
    job.install_cable_length_m != null && job.install_cable_length_m !== ''
      ? Number(job.install_cable_length_m)
      : null;
  const stickerFromCol =
    job.install_ont_sticker_photo_path != null && String(job.install_ont_sticker_photo_path).trim() !== ''
      ? String(job.install_ont_sticker_photo_path).trim()
      : null;

  return {
    description,
    photoPath,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    cableLengthM: Number.isFinite(cableCol) ? cableCol : null,
    stickerPhotoPath: stickerFromCol || stickerFromNotes
  };
}

/** Catatan admin (tanpa blok penyelesaian app teknisi di akhir). */
function stripTechnicianInstallCompletionNotes(notes) {
  const text = typeof notes === 'string' ? notes : '';
  const idx = text.lastIndexOf(MARKER);
  if (idx === -1) return text.trim() || null;
  const out = text.slice(0, idx).trim().replace(/\s+$/, '');
  return out || null;
}

/** Sinyal SSE/polling admin: teknisi mengubah progress instalasi. */
function notifyAdminInstallProgress() {
  try {
    require('./adminNotificationBus').pingAdminNotifications('INSTALL');
  } catch (_) {}
}

module.exports = {
  extractTechnicianInstallCompletion,
  stripTechnicianInstallCompletionNotes,
  notifyAdminInstallProgress
};
