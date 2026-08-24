import { useEffect, useState, useCallback, useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import { QrCode, Wallet, Landmark, Store, CreditCard, Copy, Check, RefreshCw } from 'lucide-react';
import api from '../api/client';

const TYPE_ORDER = ['qris', 'ewallet', 'bank', 'card', 'retail', 'other'];
const TYPE_LABELS = {
  qris: 'QRIS',
  ewallet: 'E-wallet',
  bank: 'Virtual Account',
  card: 'Kartu',
  retail: 'Minimarket',
  other: 'Lainnya',
};
const TYPE_ICONS = {
  qris: QrCode,
  ewallet: Wallet,
  bank: Landmark,
  card: CreditCard,
  retail: Store,
  other: CreditCard,
};

const CODE_LABELS = {
  NQ: 'Bayar pakai QRIS',
  SQ: 'Bayar pakai QRIS',
  GQ: 'Bayar pakai QRIS',
  SP: 'Bayar pakai QRIS',
  DA: 'DANA',
  OV: 'OVO',
  LA: 'LinkAja',
  LF: 'LinkAja',
  SA: 'ShopeePay',
  SL: 'ShopeePay',
  I1: 'BNI VA',
  M2: 'Mandiri VA',
  BR: 'BRI VA',
  BV: 'BSI VA',
  BC: 'BCA VA',
  B1: 'CIMB VA',
  BT: 'Permata VA',
  A1: 'ATM Bersama VA',
  VA: 'Maybank VA',
  AG: 'Artha Graha VA',
  NC: 'BNC VA',
  S1: 'Sampoerna VA',
  DM: 'Danamon VA',
  FT: 'Alfamart',
  IR: 'Indomart',
};

function resolveMethodType(m) {
  const name = String(m?.name || '');
  const code = String(m?.method || '');
  if (/qris/i.test(name) || /^(NQ|SQ|GQ|SP)$/i.test(code) || m?.type === 'qris') return 'qris';
  return m?.type || 'other';
}

function displayName(m) {
  const code = String(m?.method || '').toUpperCase();
  if (CODE_LABELS[code]) return CODE_LABELS[code];
  const raw = String(m?.name || '').trim();
  if (/qris/i.test(raw)) return 'Bayar pakai QRIS';
  if (/indomaret|indomart/i.test(raw)) return 'Indomart';
  if (/retail|alfamart|pegadaian|\balfa\b/i.test(raw)) return 'Alfamart';
  if (/linkaja/i.test(raw)) return 'LinkAja';
  if (/dana/i.test(raw)) return 'DANA';
  if (/ovo/i.test(raw)) return 'OVO';
  if (/shopee/i.test(raw)) return 'ShopeePay';
  let name = raw.replace(/\s+H2H\b/ig, '').replace(/\s+VIRTUAL ACCOUNT\b/ig, ' VA').replace(/\s+/g, ' ').trim();
  if (resolveMethodType(m) === 'bank') {
    name = name.replace(/\s+VA$/i, '').trim();
    if (name && !/VA$/i.test(name)) name = `${name} VA`;
  }
  return name || raw;
}

function walletBrandKey(m) {
  const label = displayName(m).toUpperCase();
  const code = String(m?.method || '').toUpperCase();
  if (label.includes('LINKAJA') || code === 'LA' || code === 'LF') return 'LINKAJA';
  if (label.includes('DANA') || code === 'DA') return 'DANA';
  if (label.includes('OVO') || code === 'OV' || code === 'OL') return 'OVO';
  if (label.includes('SHOPEE') || code === 'SA' || code === 'SL') return 'SHOPEEPAY';
  return `${m.gateway}:${code}`;
}

function collapseItems(type, items) {
  if (type === 'qris') {
    const preferred = items.find((m) => /^NQ$/i.test(m.method)) || items[0];
    return preferred
      ? [{ ...preferred, display_name: 'Bayar pakai QRIS', image_url: null, hide_logo: true }]
      : [];
  }
  if (type === 'ewallet') {
    const seen = new Map();
    items.forEach((m) => {
      const key = walletBrandKey(m);
      if (!seen.has(key)) seen.set(key, { ...m, display_name: displayName(m) });
    });
    return Array.from(seen.values());
  }
  return items.map((m) => ({ ...m, display_name: displayName(m) }));
}

function statusLabel(ds) {
  if (ds === 'lunas') return 'Lunas';
  if (ds === 'overdue') return 'Jatuh tempo lewat';
  if (ds === 'belum_bayar') return 'Belum bayar';
  return ds ? String(ds).replace(/_/g, ' ') : '—';
}

function isInvoicePaid(inv) {
  if (!inv) return false;
  if (inv.display_status === 'lunas') return true;
  return String(inv.status || '').toLowerCase().trim() === 'paid';
}

function isSelectableMethod(m) {
  const code = String(m?.method || '').trim();
  return code && code.toLowerCase() !== 'all';
}

function groupMethods(methods) {
  const selectable = (methods || []).filter(isSelectableMethod);
  const simple = (methods || []).filter((m) => !isSelectableMethod(m));
  const groups = TYPE_ORDER
    .map((type) => ({
      type,
      label: TYPE_LABELS[type],
      items: collapseItems(type, selectable.filter((m) => resolveMethodType(m) === type)),
    }))
    .filter((g) => g.items.length > 0);
  return { groups, simple, selectable };
}

function feeText(m) {
  const fee = String(m?.fee_customer || '').trim();
  if (!fee || /^gratis$/i.test(fee) || fee === 'Rp 0') return '';
  return fee;
}

export default function InvoiceDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [err, setErr] = useState('');
  const [payInfo, setPayInfo] = useState(null);
  const [payErr, setPayErr] = useState('');
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [paySession, setPaySession] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setData(null);
    setErr('');
    setPayInfo(null);
    setPayErr('');
    setPaySession(null);
    api.get(`/invoices/${id}`).then((r) => {
      if (r.data.success) setData(r.data);
      else setErr(r.data.message || 'Gagal');
    }).catch((e) => setErr(e.response?.data?.message || 'Gagal memuat'));
  }, [id]);

  const loadPayOptions = useCallback(() => {
    if (!id) return;
    setPayErr('');
    api.get(`/invoices/${id}/payment-options`).then((r) => {
      if (r.data.success) setPayInfo(r.data);
      else setPayErr(r.data.message || 'Gagal memuat opsi bayar');
    }).catch((e) => setPayErr(e.response?.data?.message || 'Gagal memuat opsi bayar'));
  }, [id]);

  useEffect(() => {
    if (!data?.invoice) return;
    if (isInvoicePaid(data.invoice)) {
      setPayInfo({ already_paid: true, gateways: [], methods: [] });
      return;
    }
    loadPayOptions();
  }, [data, loadPayOptions]);

  const startCheckout = async (gatewayId, method, label) => {
    if (!gatewayId || checkoutBusy) return;
    const key = `${gatewayId}:${method || 'all'}`;
    setCheckoutBusy(true);
    setBusyKey(key);
    setPayErr('');
    try {
      const payload = { gateway: gatewayId };
      if (method && method !== 'all') payload.method = method;
      const r = await api.post(`/invoices/${id}/checkout`, payload);
      if (!r.data.success) {
        setPayErr(r.data.message || 'Gagal membuat pembayaran');
        return;
      }
      const session = {
        ...r.data,
        method_label: label || r.data.method_label || '',
        app_url: r.data.app_url || r.data.payment_url || '',
      };
      const validQris = typeof session.qr_string === 'string' && session.qr_string.startsWith('000201');
      if (validQris || session.va_number) {
        setPaySession({ ...session, qr_string: validQris ? session.qr_string : null, qr_image: validQris ? session.qr_image : null });
        return;
      }
      if (session.app_url) {
        setPaySession({ ...session, display_mode: 'app' });
        window.open(session.app_url, '_blank', 'noopener,noreferrer');
        return;
      }
      setPayErr('Kode pembayaran belum tersedia. Coba metode lain atau hubungi admin.');
    } catch (e) {
      setPayErr(e.response?.data?.message || e.message || 'Gagal membuat pembayaran');
    } finally {
      setCheckoutBusy(false);
      setBusyKey('');
    }
  };

  useEffect(() => {
    if (!paySession || !id) return undefined;
    const tick = async () => {
      try {
        const r = await api.get(`/invoices/${id}/payment-status`, {
          params: paySession.order_id ? { order_id: paySession.order_id } : {},
        });
        if (r.data?.paid) {
          const invRes = await api.get(`/invoices/${id}`);
          if (invRes.data?.success) setData(invRes.data);
          setPaySession(null);
        }
      } catch {
        /* ignore poll errors */
      }
    };
    const timer = setInterval(tick, 5000);
    return () => clearInterval(timer);
  }, [paySession, id]);

  const copyVa = async (value) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setPayErr('Gagal menyalin kode. Salin manual.');
    }
  };

  const grouped = useMemo(() => groupMethods(payInfo?.methods || []), [payInfo]);
  const gateways = payInfo?.gateways || [];
  const hasSelectableMethods = grouped.selectable.length > 0;
  const simpleGateways = gateways.filter((g) => {
    if (g.id === 'duitku' || g.id === 'tripay') return false;
    const gwMethods = (payInfo?.methods || []).filter((m) => m.gateway === g.id && isSelectableMethod(m));
    return gwMethods.length === 0;
  });
  const duitkuEnabled = gateways.some((g) => g.id === 'duitku' || g.id === 'tripay');
  const methodsMissing = Boolean(payInfo && !payInfo.already_paid && duitkuEnabled && !hasSelectableMethods);

  if (err) {
    return (
      <div className="space-y-4">
        <Link to="/tagihan" className="text-sm font-semibold text-sky-700">← Kembali</Link>
        <p className="text-rose-700 text-sm bg-rose-50 border border-rose-200 rounded-2xl px-4 py-3">{err}</p>
      </div>
    );
  }
  if (!data) return <p className="text-slate-500 py-4">Memuat…</p>;

  const inv = data.invoice;
  const paid = isInvoicePaid(inv);

  return (
    <div className="max-w-lg space-y-5">
      <Link to="/tagihan" className="text-sm font-semibold text-sky-700 inline-block">← Kembali ke daftar</Link>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4 shadow-sm">
        <div>
          <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wide">Invoice</p>
          <p className="text-xl font-mono font-bold text-slate-900 mt-1">{inv.invoice_number}</p>
        </div>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between gap-4 py-1 border-b border-slate-100">
            <dt className="text-slate-500">Status</dt>
            <dd className="text-slate-900 font-semibold">{statusLabel(inv.display_status)}</dd>
          </div>
          <div className="flex justify-between gap-4 py-1 border-b border-slate-100">
            <dt className="text-slate-500">Jumlah</dt>
            <dd className="text-slate-900 font-bold">Rp {Number(inv.amount || 0).toLocaleString('id-ID')}</dd>
          </div>
          <div className="flex justify-between gap-4 py-1 border-b border-slate-100">
            <dt className="text-slate-500">Jatuh tempo</dt>
            <dd className="text-slate-900 font-medium">{inv.due_date || '-'}</dd>
          </div>
          <div className="flex justify-between gap-4 py-1">
            <dt className="text-slate-500">Dibuat</dt>
            <dd className="text-slate-900 font-medium">{inv.created_at?.slice(0, 19)?.replace('T', ' ') || '-'}</dd>
          </div>
        </dl>
        {data.pdf_hint && (
          <p className="text-xs text-slate-500 border-t border-slate-100 pt-4 leading-relaxed">{data.pdf_hint}</p>
        )}
      </div>

      {!paid && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
          <h3 className="text-lg font-bold text-slate-900">Bayar tagihan</h3>
          <p className="text-sm text-slate-600">
            {paySession
              ? 'Selesaikan pembayaran di halaman ini. Jangan tutup sampai status menjadi lunas.'
              : 'Pilih cara bayar. Kode QR atau nomor VA akan tampil di halaman ini.'}
          </p>
          {payErr && (
            <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">{payErr}</p>
          )}
          {!payInfo && (
            <p className="text-sm text-slate-500">Memuat opsi pembayaran…</p>
          )}
          {paySession && (
            <div className="rounded-2xl border border-sky-200 bg-sky-50/60 p-4 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] font-bold uppercase tracking-wide text-sky-700">
                    {paySession.display_mode === 'qr' ? 'QRIS' : (paySession.display_mode === 'va' ? 'Kode bayar' : 'Pembayaran')}
                  </p>
                  <p className="font-bold text-slate-900 mt-0.5">
                    {paySession.method_label || (paySession.display_mode === 'qr' ? 'Bayar pakai QRIS' : 'Menunggu pembayaran')}
                  </p>
                  <p className="text-sm text-slate-600 mt-1">
                    Rp {Number(paySession.amount || inv.amount || 0).toLocaleString('id-ID')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPaySession(null)}
                  className="text-xs font-semibold text-sky-700 hover:text-sky-900 shrink-0"
                >
                  Ganti metode
                </button>
              </div>

              {paySession.sandbox && (
                <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                  QRIS ini mode sandbox Duitku. Aplikasi bank asli (BCA, Mandiri, dll.) biasanya menolak karena bukan QRIS GPN production. Aktifkan Production Mode di pengaturan Duitku, atau uji dengan aplikasi sandbox Duitku.
                </p>
              )}

              {(paySession.qr_image || (paySession.qr_string && paySession.qr_string.startsWith('000201'))) && (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 flex flex-col items-center">
                  <img
                    src={paySession.qr_image || `https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=4&ecc=M&data=${encodeURIComponent(paySession.qr_string)}`}
                    alt="QRIS"
                    className="w-72 h-72 bg-white"
                    style={{ imageRendering: 'pixelated' }}
                  />
                  <p className="text-xs text-slate-500 text-center mt-3 leading-relaxed">
                    Scan dengan QRIS di BCA, DANA, GoPay, OVO, ShopeePay, atau LinkAja. Jangan diperkecil layar.
                  </p>
                </div>
              )}

              {paySession.va_number && (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Nomor / kode bayar</p>
                  <p className="font-mono text-xl sm:text-2xl font-bold text-slate-900 tracking-wide break-all text-center">
                    {paySession.va_number}
                  </p>
                  <button
                    type="button"
                    onClick={() => copyVa(paySession.va_number)}
                    className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-slate-900 text-white text-sm font-semibold py-2.5"
                  >
                    {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                    {copied ? 'Tersalin' : 'Salin kode'}
                  </button>
                </div>
              )}

              {paySession.display_mode === 'app' && paySession.app_url && (
                <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                  <p className="text-sm text-slate-600 leading-relaxed">
                    {paySession.method_label || 'E-wallet'} tidak menampilkan QR. Lanjutkan pembayaran di aplikasi, lalu kembali ke halaman ini.
                  </p>
                  <a
                    href={paySession.app_url}
                    target="_blank"
                    rel="noreferrer"
                    className="block w-full text-center rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold py-3"
                  >
                    Buka {paySession.method_label || 'e-wallet'}
                  </a>
                </div>
              )}

              <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Menunggu konfirmasi pembayaran…
              </p>
            </div>
          )}
          {payInfo && payInfo.already_paid && (
            <p className="text-sm text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2">Tagihan ini sudah lunas.</p>
          )}
          {payInfo && !payInfo.already_paid && !hasSelectableMethods && simpleGateways.length === 0 && !methodsMissing && (
            <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              Pembayaran online belum diaktifkan. Silakan hubungi layanan pelanggan untuk transfer manual atau aktivasi gateway.
            </p>
          )}
          {!paySession && methodsMissing && (
            <div className="space-y-2">
              <p className="text-sm text-amber-900 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
                Daftar metode pembayaran belum bisa dimuat dari Duitku. Pastikan channel sudah aktif di dashboard, lalu muat ulang.
              </p>
              <button
                type="button"
                onClick={loadPayOptions}
                className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-sky-700"
              >
                Muat ulang metode pembayaran
              </button>
            </div>
          )}

          {!paySession && payInfo && !payInfo.already_paid && hasSelectableMethods && (
            <div className="space-y-5">
              {grouped.groups.map((group) => {
                const Icon = TYPE_ICONS[group.type] || CreditCard;
                if (group.type === 'qris') {
                  const m = group.items[0];
                  const key = `${m.gateway}:${m.method}`;
                  const busy = checkoutBusy && busyKey === key;
                  return (
                    <div key={group.type}>
                      <button
                        type="button"
                        disabled={checkoutBusy}
                        onClick={() => startCheckout(m.gateway, m.method, 'Bayar pakai QRIS')}
                        className="w-full rounded-2xl bg-gradient-to-r from-sky-600 to-cyan-500 text-white px-4 py-4 shadow-md hover:from-sky-500 hover:to-cyan-400 transition active:scale-[0.99] disabled:opacity-50"
                      >
                        <span className="flex items-center gap-3">
                          <span className="h-12 w-12 rounded-2xl bg-white/20 flex items-center justify-center shrink-0">
                            <QrCode className="h-7 w-7" />
                          </span>
                          <span className="text-left min-w-0">
                            <span className="block font-extrabold text-base tracking-wide">BAYAR PAKAI QRIS</span>
                            <span className="block text-xs text-white/85 mt-0.5">
                              {busy ? 'Menghubungkan…' : 'Scan dari DANA, GoPay, OVO, ShopeePay, dan lainnya'}
                            </span>
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                }
                return (
                  <div key={group.type} className="space-y-2">
                    <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                      <Icon className="h-3.5 w-3.5" />
                      {group.label}
                    </p>
                    <div className={`grid gap-2 ${group.items.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
                      {group.items.map((m) => {
                        const key = `${m.gateway}:${m.method}`;
                        const busy = checkoutBusy && busyKey === key;
                        const fee = feeText(m);
                        const label = m.display_name || displayName(m);
                        return (
                          <button
                            key={key}
                            type="button"
                            disabled={checkoutBusy}
                            onClick={() => startCheckout(m.gateway, m.method, label)}
                            className="w-full text-left rounded-2xl border border-slate-200 bg-white hover:border-sky-300 hover:shadow-sm px-3.5 py-3.5 transition active:scale-[0.99] disabled:opacity-50"
                          >
                            <span className="flex items-center gap-3">
                              {m.image_url ? (
                                <span className="h-10 w-10 rounded-xl bg-slate-50 border border-slate-100 flex items-center justify-center shrink-0 overflow-hidden">
                                  <img src={m.image_url} alt="" className="h-7 w-7 object-contain" />
                                </span>
                              ) : (
                                <span className="h-10 w-10 rounded-xl bg-sky-50 text-sky-700 flex items-center justify-center shrink-0">
                                  <Icon className="h-5 w-5" />
                                </span>
                              )}
                              <span className="min-w-0">
                                <span className="block font-bold text-sm text-slate-900 leading-tight">{label}</span>
                                <span className="block text-[11px] text-slate-500 mt-0.5">
                                  {busy ? 'Menghubungkan…' : (fee ? `Biaya ${fee}` : 'Tanpa biaya')}
                                </span>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {!paySession && payInfo && !payInfo.already_paid && simpleGateways.length > 0 && (
            <div className="space-y-2">
              {simpleGateways.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  disabled={checkoutBusy}
                  onClick={() => startCheckout(g.id)}
                  className={`w-full text-left rounded-xl border px-4 py-3.5 transition active:scale-[0.99] ${
                    g.is_default
                      ? 'border-sky-400 bg-sky-50 text-slate-900 ring-1 ring-sky-200'
                      : 'border-slate-200 bg-slate-50 hover:bg-white text-slate-900'
                  } disabled:opacity-50`}
                >
                  <span className="block font-bold text-sm">{g.name}</span>
                  {g.is_default && (
                    <span className="text-[11px] font-semibold text-sky-700">Disarankan</span>
                  )}
                </button>
              ))}
            </div>
          )}

          {!paySession && checkoutBusy && (
            <p className="text-xs text-slate-500 text-center pt-1">Menghubungkan ke pembayaran…</p>
          )}
        </div>
      )}

      {paid && (
        <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 px-4 py-3 text-sm text-emerald-900 font-medium text-center">
          Tagihan sudah lunas. Terima kasih.
        </div>
      )}
    </div>
  );
}
