-- Bukti transfer pembayaran kolektor (path relatif di public/)
ALTER TABLE payments ADD COLUMN payment_proof TEXT;
