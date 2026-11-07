// Madelane Nails · API de reservas (Cloudflare Worker + D1 + Resend)
// La web estática vive en /public; este Worker responde todo lo que empieza por /api/
// y corre cada hora (cron) para enviar recordatorios y el resumen del día siguiente.

const TZ = "America/Caracas";
const SITE = "https://madelanenails.com";
const FROM = "Madelane Nails <citas@madelanenails.com>";
const LOGO = SITE + "/imagenes/logo.png";
const STATUS = ["pendiente", "confirmada", "cancelada", "completada", "no_asistio"];
const ACTIVE = ["pendiente", "confirmada"];
const MIN_FILL_MS = 4000;      // un formulario llenado en menos tiempo es de un bot
const TRAP_LIMIT = 3;          // trampas activadas en 24 h antes de bloquear la IP
const MAX_PENDING_PER_PERSON = 2;
const DAILY_HOUR = 19;         // 7 p. m. de Caracas: recordatorios a las clientas y resumen de mañana a Madelane
const SESSION_HOURS = 12;
const TERMS_VERSION = "Términos y Privacidad del 2026-11-07"; // cambiar si se actualizan las páginas legales
const KEEP_DAYS = 730;          // las citas se borran 2 años después de su fecha (Política de privacidad)
const KEEP_IP_DAYS = 90;        // la IP de seguridad se borra a los 90 días

// Valores iniciales. Madelane puede cambiarlos desde el panel admin.
const DEF = {
  slot: 30,
  // [abierto, desde, hasta, almuerzo desde, almuerzo hasta] · domingo=0 ... sábado=6
  hours: [[0, 9, 18, 0, 0], [1, 9, 18, 0, 0], [1, 9, 18, 0, 0], [1, 9, 18, 0, 0], [1, 9, 18, 0, 0], [1, 9, 18, 0, 0], [1, 9, 18, 0, 0]],
  wa: "584141887538",
  waShow: "0414-1887538",
  email: "",
  services: [
    { n: "Esmalte semipermanente de manos", p: 8, dur: 60, d: "Color brillante y duradero que no se descascara en semanas.", k: "" },
    { n: "Esmalte semipermanente de pies", p: 8, dur: 60, d: "El mismo acabado duradero, para unos pies impecables.", k: "" },
    { n: "Nivelación rubber", p: 10, dur: 90, d: "Base flexible que nivela y refuerza tu uña natural.", k: "" },
    { n: "Aplicación de polygel", p: 12, dur: 120, d: "Uñas reforzadas o alargadas, moldeadas a tu gusto.", k: "" },
    { n: "Jellytips o softgel", p: 14, dur: 120, d: "Alargamiento ligero con tips de gel suave, natural y cómodo.", k: "" },
    { n: "Esmaltado semipermanente vegano", p: 10, dur: 60, d: "Fórmula libre de ingredientes de origen animal.", k: "Vegano" }
  ]
};

// ---------- utilidades ----------
const enc = (s) => new TextEncoder().encode(s);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const sha = async (s) => b64(await crypto.subtle.digest("SHA-256", enc(s)));
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey("raw", enc(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", k, enc(msg)));
}
const eq = (a, b) => { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i); return r === 0; };
const clean = (v, n) => String(v ?? "").trim().slice(0, n);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });
const nowHM = () => new Date().toLocaleTimeString("en-GB", { timeZone: TZ, hour12: false, hour: "2-digit", minute: "2-digit" });
const nowHour = () => +new Date().toLocaleString("en-GB", { timeZone: TZ, hour12: false, hour: "2-digit" });
const addDays = (d, n) => { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const minOf = (t) => { const [H, M] = t.split(":").map(Number); return H * 60 + M; };
const hmOf = (m) => String(Math.floor(m / 60)).padStart(2, "0") + ":" + String(m % 60).padStart(2, "0");
const f12 = (t) => { const [H, M] = t.split(":").map(Number); return (H % 12 || 12) + ":" + String(M).padStart(2, "0") + " " + (H < 12 ? "a. m." : "p. m."); };
const longDate = (d) => { const s = new Date(d + "T12:00:00Z").toLocaleDateString("es-VE", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }); return s.charAt(0).toUpperCase() + s.slice(1); };
const code = (id) => "MN-" + String(id).padStart(4, "0");
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

// ---------- configuración ----------
async function cfg(env) {
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key='config'").first();
  const s = r ? JSON.parse(r.value) : {};
  const c = { ...DEF, ...s };
  if (!Array.isArray(c.services) || !c.services.length) c.services = DEF.services;
  if (!Array.isArray(c.hours) || c.hours.length !== 7) c.hours = DEF.hours;
  c.hours = c.hours.map((h) => [h[0] ? 1 : 0, +h[1] || 0, +h[2] || 0, +h[3] || 0, +h[4] || 0]);
  return c;
}
const owner = (env, c) => clean(c.email || env.NOTIFY_EMAIL || "", 120);
const svcOf = (c, name) => c.services.find((s) => s.n === name);

// ---------- disponibilidad ----------
async function busy(env, date, exceptId) {
  const { results } = await env.DB.prepare("SELECT id,time,dur FROM appointments WHERE date=? AND status IN ('pendiente','confirmada')").bind(date).all();
  return (results || []).filter((r) => r.id !== exceptId).map((r) => ({ id: r.id, s: minOf(r.time), e: minOf(r.time) + (+r.dur || 60) }));
}
// Horas en las que cabe un servicio de "dur" minutos ese día.
async function freeTimes(env, c, date, dur, exceptId) {
  const h = c.hours[dow(date)];
  if (!h || !h[0]) return [];
  const b = await busy(env, date, exceptId), out = [];
  const open = Math.round(h[1] * 60), close = Math.round(h[2] * 60), ls = Math.round(h[3] * 60), le = Math.round(h[4] * 60);
  const isToday = date === today(), now = minOf(nowHM());
  for (let t = open; t + dur <= close; t += c.slot) {
    if (le > ls && t < le && t + dur > ls) continue;           // choca con el almuerzo
    if (isToday && t <= now + 60) continue;                    // al menos 1 hora de aviso
    if (b.some((r) => t < r.e && t + dur > r.s)) continue;     // choca con otra cita
    out.push(hmOf(t));
  }
  return out;
}
// Si dos personas reservan a la vez, gana la que llegó primero.
async function lostRace(env, id, date) {
  const { results } = await env.DB.prepare("SELECT id,time,dur FROM appointments WHERE date=? AND status IN ('pendiente','confirmada')").bind(date).all();
  const me = (results || []).find((r) => r.id === id);
  if (!me) return false;
  const s = minOf(me.time), e = s + me.dur;
  return results.some((r) => r.id < id && minOf(r.time) < e && minOf(r.time) + r.dur > s);
}

// ---------- anti-bots ----------
async function trapHit(env, ip, motivo) {
  try {
    await env.DB.prepare("DELETE FROM trampas WHERE ts<?").bind(Date.now() - 7 * 864e5).run();
    await env.DB.prepare("INSERT INTO trampas(ip,ts,motivo) VALUES(?,?,?)").bind(ip, Date.now(), motivo).run();
  } catch (e) {}
}
async function trapBlocked(env, ip) {
  try { const r = await env.DB.prepare("SELECT COUNT(*) n FROM trampas WHERE ip=? AND ts>?").bind(ip, Date.now() - 864e5).first(); return r.n >= TRAP_LIMIT; } catch (e) { return false; }
}
async function human(env, token, ip) {
  if (!env.TURNSTILE_SECRET) return true;
  try {
    const v = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: env.TURNSTILE_SECRET, response: String(token || ""), remoteip: ip }) });
    return (await v.json()).success === true;
  } catch (e) { return false; }
}

// ---------- correos ----------
async function mail(env, to, subject, html, text, replyTo) {
  if (!env.RESEND_API_KEY || !to) return "none";
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: Array.isArray(to) ? to : [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) })
    });
    return r.ok ? "sent" : "failed";
  } catch (e) { return "failed"; }
}
const shell = (body) => `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#271f2b">
<div style="background:#faf6f9;padding:18px 22px;text-align:center;border-bottom:2px solid #c09dcb"><img src="${LOGO}" width="120" height="114" alt="Madelane Nails" style="display:block;margin:0 auto;width:120px;height:auto;border:0;color:#76607b;font-size:20px"></div>
<div style="padding:24px;border:1px solid #e7dde6;border-top:0">${body}</div>
<p style="text-align:center;font-size:12px;color:#8b8090;margin:14px 0">Madelane Nails · Manicurista · Pampatar, Isla de Margarita<br><a href="https://www.instagram.com/madelane.nails" style="color:#76607b">Instagram @madelane.nails</a></p></div>`;
const row = (k, v) => `<tr><td style="padding:8px 16px 8px 0;color:#5a4c5f;white-space:nowrap;vertical-align:top">${k}</td><td style="padding:8px 0"><b>${esc(v)}</b></td></tr>`;
const table = (a, extra = "") => `<table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #e7dde6;margin:10px 0">${row("Servicio", a.service)}${row("Fecha", longDate(a.date))}${row("Hora", f12(a.time))}${extra}</table>`;
const btn = (href, label, bg = "#76607b") => `<a href="${href}" style="display:inline-block;background:${bg};color:#fff;text-decoration:none;padding:12px 24px;border-radius:99px;font-weight:bold;font-size:14px">${label}</a>`;
const waLink = (c, t) => "https://wa.me/" + c.wa + (t ? "?text=" + encodeURIComponent(t) : "");
const codeLine = (a) => `<p style="font-size:12px;color:#8b8090;margin:16px 0 0">Número de cita: <b>${code(a.id)}</b></p>`;
const priceOf = (c, a) => { const s = svcOf(c, a.service); return s ? "$" + s.p + " (tasa BCV)" : ""; };

// A la clienta, al reservar: queda pendiente hasta que Madelane confirme.
function mailPending(env, a, c) {
  const p = priceOf(c, a);
  const html = shell(`<p style="font-size:16px">Hola ${esc(a.name)},</p>
<p>¡Gracias por agendar con Madelane Nails! Recibí tu solicitud de cita y está <b>pendiente de confirmación</b>.</p>
${table(a, p ? row("Precio", p) : "")}
<p>Te escribiré por WhatsApp para confirmarla y enviarte la ubicación exacta en Pampatar.</p>
<p style="text-align:center;margin:20px 0">${btn(waLink(c, "Hola Madelane, agendé una cita (" + code(a.id) + ") para el " + longDate(a.date) + " a las " + f12(a.time) + "."), "Escribirme por WhatsApp", "#25a244")}</p>
<p>¡Nos vemos pronto!<br><b>Madelane</b></p>${codeLine(a)}`);
  const text = `Hola ${a.name},\n\nRecibí tu solicitud de cita y está pendiente de confirmación.\n\nServicio: ${a.service}\nFecha: ${longDate(a.date)}\nHora: ${f12(a.time)}${p ? "\nPrecio: " + p : ""}\n\nTe escribiré por WhatsApp para confirmarla y enviarte la ubicación exacta en Pampatar.\nWhatsApp: ${c.waShow}\n\nNúmero de cita: ${code(a.id)}\nMadelane Nails`;
  return mail(env, a.email, `Recibí tu solicitud de cita (${code(a.id)}) - Madelane Nails`, html, text, owner(env, c));
}
// A la clienta, cuando Madelane confirma (o crea la cita desde el panel).
function mailConfirmed(env, a, c) {
  const p = priceOf(c, a);
  const html = shell(`<p style="font-size:16px">Hola ${esc(a.name)},</p>
<p>¡Tu cita está <b>confirmada</b>! 💅</p>
${table(a, p ? row("Precio", p) : "")}
<p>La ubicación exacta en Pampatar te la envío por WhatsApp. Te mandaré un recordatorio el día antes.</p>
<p style="font-size:14px;color:#5a4c5f">Si traes esmalte o recubrimiento puesto, avísame para sumar el retiro. Si necesitas cambiar la cita, escríbeme con al menos 24 horas de anticipación.</p>
<p style="text-align:center;margin:20px 0">${btn(waLink(c, "Hola Madelane, sobre mi cita " + code(a.id) + "."), "Escribirme por WhatsApp", "#25a244")}</p>
<p>¡Te espero!<br><b>Madelane</b></p>${codeLine(a)}`);
  const text = `Hola ${a.name},\n\n¡Tu cita está confirmada!\n\nServicio: ${a.service}\nFecha: ${longDate(a.date)}\nHora: ${f12(a.time)}${p ? "\nPrecio: " + p : ""}\n\nLa ubicación exacta en Pampatar te la envío por WhatsApp (${c.waShow}).\nSi necesitas cambiar la cita, avísame con al menos 24 horas de anticipación.\n\nNúmero de cita: ${code(a.id)}\nMadelane Nails`;
  return mail(env, a.email, `Tu cita está confirmada (${code(a.id)}) - Madelane Nails`, html, text, owner(env, c));
}
function mailCancelled(env, a, c) {
  const html = shell(`<p style="font-size:16px">Hola ${esc(a.name)},</p>
<p>Tu cita fue <b>cancelada</b>.</p>${table(a)}
<p>Si quieres agendar otra fecha, puedes hacerlo en la web o escribirme por WhatsApp.</p>
<p style="text-align:center;margin:20px 0">${btn(SITE + "/reservar", "Agendar otra cita")}</p>
<p><b>Madelane</b></p>${codeLine(a)}`);
  const text = `Hola ${a.name},\n\nTu cita fue cancelada.\n\nServicio: ${a.service}\nFecha: ${longDate(a.date)}\nHora: ${f12(a.time)}\n\nPara agendar otra fecha: ${SITE}/reservar o WhatsApp ${c.waShow}.\n\nNúmero de cita: ${code(a.id)}\nMadelane Nails`;
  return mail(env, a.email, `Tu cita fue cancelada (${code(a.id)}) - Madelane Nails`, html, text, owner(env, c));
}
function mailMoved(env, a, c, old) {
  const html = shell(`<p style="font-size:16px">Hola ${esc(a.name)},</p>
<p>Tu cita cambió de fecha u hora. Estos son los datos nuevos:</p>${table(a)}
<p style="font-size:14px;color:#5a4c5f">Antes: ${esc(longDate(old.date))} a las ${esc(f12(old.time))}.</p>
<p>Si este horario no te queda bien, escríbeme por WhatsApp.</p>
<p style="text-align:center;margin:20px 0">${btn(waLink(c, "Hola Madelane, sobre el cambio de mi cita " + code(a.id) + "."), "Escribirme por WhatsApp", "#25a244")}</p>
<p><b>Madelane</b></p>${codeLine(a)}`);
  const text = `Hola ${a.name},\n\nTu cita cambió. Datos nuevos:\n\nServicio: ${a.service}\nFecha: ${longDate(a.date)}\nHora: ${f12(a.time)}\n\nAntes: ${longDate(old.date)} a las ${f12(old.time)}.\nWhatsApp: ${c.waShow}\n\nNúmero de cita: ${code(a.id)}\nMadelane Nails`;
  return mail(env, a.email, `Tu cita cambió de horario (${code(a.id)}) - Madelane Nails`, html, text, owner(env, c));
}
function mailReminder(env, a, c) {
  const html = shell(`<p style="font-size:16px">Hola ${esc(a.name)},</p>
<p>Te recuerdo tu cita de <b>mañana</b>:</p>${table(a)}
<p>Si no puedes venir, avísame por WhatsApp lo antes posible para darle el cupo a otra clienta.</p>
<p style="text-align:center;margin:20px 0">${btn(waLink(c, "Hola Madelane, sobre mi cita de mañana (" + code(a.id) + ")."), "Escribirme por WhatsApp", "#25a244")}</p>
<p>¡Te espero!<br><b>Madelane</b></p>${codeLine(a)}`);
  const text = `Hola ${a.name},\n\nTe recuerdo tu cita de mañana:\n\nServicio: ${a.service}\nFecha: ${longDate(a.date)}\nHora: ${f12(a.time)}\n\nSi no puedes venir, avísame por WhatsApp: ${c.waShow}\n\nNúmero de cita: ${code(a.id)}\nMadelane Nails`;
  return mail(env, a.email, `Recordatorio: tu cita es mañana (${code(a.id)}) - Madelane Nails`, html, text, owner(env, c));
}
// A Madelane, cuando llega una reserva nueva desde la web.
function mailOwnerNew(env, a, c) {
  const to = owner(env, c);
  if (!to) return "none";
  const extra = row("Teléfono", a.phone) + row("Correo", a.email) + (a.notes ? row("Notas", a.notes) : "");
  const html = shell(`<p style="font-size:16px">¡Nueva reserva!</p>
<p><b>${esc(a.name)}</b> agendó una cita y está <b>pendiente de que la confirmes</b>.</p>${table(a, extra)}
<p style="text-align:center;margin:20px 0">${btn(SITE + "/admin", "Abrir el panel")} ${btn("https://wa.me/" + a.phone.replace(/\D/g, ""), "WhatsApp de la clienta", "#25a244")}</p>
<p style="font-size:13px;color:#5a4c5f">Escríbele para confirmar, mándale la ubicación y pulsa <b>Confirmar</b> en el panel: le llegará un correo de confirmación.</p>${codeLine(a)}`);
  const text = `Nueva reserva pendiente\n\n${a.name}\n${a.service}\n${longDate(a.date)} a las ${f12(a.time)}\nTel: ${a.phone}\nCorreo: ${a.email}${a.notes ? "\nNotas: " + a.notes : ""}\n\nConfírmala en ${SITE}/admin\nNúmero de cita: ${code(a.id)}`;
  return mail(env, to, `Nueva reserva: ${a.name} · ${longDate(a.date)} ${f12(a.time)} (${code(a.id)})`, html, text, a.email);
}
function mailOwnerDigest(env, c, date, rows) {
  const to = owner(env, c);
  if (!to || !rows.length) return "none";
  const list = rows.map((r) => `<tr><td style="padding:8px 12px 8px 0;white-space:nowrap"><b>${esc(f12(r.time))}</b></td><td style="padding:8px 0">${esc(r.name)} · ${esc(r.service)}<br><span style="color:#5a4c5f;font-size:13px">${esc(r.phone)}${r.status === "pendiente" ? " · <b style='color:#b4541c'>sin confirmar</b>" : ""}</span></td></tr>`).join("");
  const html = shell(`<p style="font-size:16px">Tus citas de mañana, ${esc(longDate(date))}:</p><table style="width:100%;border-collapse:collapse;font-size:15px;border-top:1px solid #e7dde6">${list}</table><p style="text-align:center;margin:20px 0">${btn(SITE + "/admin", "Abrir el panel")}</p>`);
  const text = "Tus citas de mañana, " + longDate(date) + ":\n\n" + rows.map((r) => f12(r.time) + " · " + r.name + " · " + r.service + " · " + r.phone + (r.status === "pendiente" ? " (sin confirmar)" : "")).join("\n");
  return mail(env, to, `Tus citas de mañana (${rows.length}) - Madelane Nails`, html, text);
}

// ---------- tarea diaria (cron) ----------
async function daily(env) {
  if (nowHour() < DAILY_HOUR) return;
  const d = today();
  const last = await env.DB.prepare("SELECT value FROM settings WHERE key='daily:last'").first();
  if (last && last.value === d) return;
  await env.DB.prepare("INSERT INTO settings(key,value) VALUES('daily:last',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(d).run();
  const c = await cfg(env), tm = addDays(d, 1);
  const { results } = await env.DB.prepare("SELECT * FROM appointments WHERE date=? AND status IN ('pendiente','confirmada') ORDER BY time").bind(tm).all();
  const rows = results || [];
  for (const a of rows) {
    if (a.status === "confirmada" && !a.reminded && a.email) {
      if ((await mailReminder(env, a, c)) === "sent") await env.DB.prepare("UPDATE appointments SET reminded=1 WHERE id=?").bind(a.id).run();
    }
  }
  await mailOwnerDigest(env, c, tm, rows);
  // Conservación de datos según la Política de privacidad
  await env.DB.prepare("UPDATE appointments SET ip=NULL WHERE ip IS NOT NULL AND created_at < datetime('now', ?)").bind("-" + KEEP_IP_DAYS + " days").run();
  await env.DB.prepare("DELETE FROM appointments WHERE date < ?").bind(addDays(d, -KEEP_DAYS)).run();
  await env.DB.prepare("DELETE FROM trampas WHERE ts < ?").bind(Date.now() - 7 * 864e5).run();
}

// ---------- sesión del panel ----------
const sessKey = (env) => (env.SESSION_SECRET || "") + "|" + env.ADMIN_PASS + "|" + env.ADMIN_USER;
async function authed(req, env) {
  if (!env.ADMIN_USER || !env.ADMIN_PASS || !env.SESSION_SECRET) return false;
  const [exp, sig] = (req.headers.get("Authorization") || "").replace("Bearer ", "").split(".");
  if (!exp || !sig || Date.now() > +exp) return false;
  return eq(sig, await hmac(sessKey(env), "admin|" + exp));
}

// ---------- lectura de una cita ----------
function readAppt(b, c) {
  const a = { name: clean(b.name, 80), phone: clean(b.phone, 30), email: clean(b.email, 120).toLowerCase(), service: clean(b.service, 120), notes: clean(b.notes, 300), date: clean(b.date, 10), time: clean(b.time, 5) };
  const s = svcOf(c, a.service);
  a.dur = Math.round(+b.dur) >= 15 && Math.round(+b.dur) <= 480 ? Math.round(+b.dur) : s ? s.dur : 60;
  return a;
}
function check(a, c, pub) {
  if (a.name.length < 2) return "Escribe tu nombre";
  if (pub && !/^[\p{L}\p{M}][\p{L}\p{M}\s.'’-]{1,79}$/u.test(a.name)) return "Escribe tu nombre solo con letras";
  if (a.phone.replace(/\D/g, "").length < (pub ? 10 : 7)) return "Escribe un teléfono válido, por ejemplo 0414-1234567";
  if (pub && !validEmail(a.email)) return "Escribe un correo válido";
  if (!pub && a.email && !validEmail(a.email)) return "Correo no válido";
  if (!svcOf(c, a.service) && pub) return "Elige un servicio";
  if (!a.service) return "Escribe el servicio";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date) || !/^\d{2}:\d{2}$/.test(a.time)) return "Elige la fecha y la hora";
  return "";
}

// ---------- respaldo ----------
async function exportDb(env) {
  const { results: ap } = await env.DB.prepare("SELECT * FROM appointments ORDER BY date,time").all();
  const r = await env.DB.prepare("SELECT value FROM settings WHERE key='config'").first();
  return { app: "madelanenails", exported: new Date().toISOString(), config: r ? JSON.parse(r.value) : null, appointments: ap || [] };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(daily(env).catch(() => {}));
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url), path = url.pathname, m = req.method;
    const H = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
    const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: H });
    if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
    const ip = req.headers.get("CF-Connecting-IP") || "";
    const origin = req.headers.get("Origin");
    if (m !== "GET" && origin && origin !== url.origin) return out({ ok: false, error: "Origen no permitido" }, 403);
    if (m !== "GET" && +(req.headers.get("Content-Length") || 0) > 3e5) return out({ ok: false, error: "Solicitud demasiado grande" }, 413);
    const body = async () => { try { return await req.json(); } catch (e) { return {}; } };

    try {
      // ----- público -----
      if (path === "/api/config" && m === "GET") {
        const c = await cfg(env);
        return out({ ok: true, slot: c.slot, hours: c.hours, wa: c.wa, waShow: c.waShow, services: c.services, today: today(), sitekey: env.TURNSTILE_SITEKEY || "" });
      }
      if (path === "/api/slots" && m === "GET") {
        const d = url.searchParams.get("date") || "", c = await cfg(env), s = svcOf(c, url.searchParams.get("service") || "");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || d < today() || d > addDays(today(), 90)) return out({ ok: true, times: [] });
        return out({ ok: true, times: await freeTimes(env, c, d, s ? s.dur : 60, 0) });
      }
      if (path === "/api/appointments" && m === "POST") {
        const b = await body();
        if (await trapBlocked(env, ip)) return out({ ok: true, id: 0 });
        if (b.website) { await trapHit(env, ip, "campo-trampa"); return out({ ok: true, id: 0 }); }
        if (!(+b.ft >= MIN_FILL_MS)) { await trapHit(env, ip, "muy-rapido"); return out({ ok: true, id: 0 }); }
        if (b.acepto !== true) return out({ ok: false, error: "Para reservar, acepta los Términos y la Política de privacidad." }, 400);
        if (!(await human(env, b.turnstile, ip))) return out({ ok: false, error: "No pudimos verificar que eres una persona. Recarga la página e intenta de nuevo." }, 400);
        const c = await cfg(env), a = readAppt(b, c), s = svcOf(c, a.service);
        if (s) a.dur = s.dur;
        const err = check(a, c, true);
        if (err) return out({ ok: false, error: err }, 400);
        if (a.date < today() || a.date > addDays(today(), 90)) return out({ ok: false, error: "Elige una fecha dentro de los próximos 3 meses" }, 400);
        const rc = await env.DB.prepare("SELECT COUNT(*) n FROM appointments WHERE ip=? AND created_at>datetime('now','-1 hour')").bind(ip).first();
        if (rc.n >= 5) return out({ ok: false, error: "Demasiadas solicitudes. Intenta más tarde o escríbeme por WhatsApp." }, 429);
        const pp = await env.DB.prepare("SELECT COUNT(*) n FROM appointments WHERE status='pendiente' AND date>=? AND (lower(email)=? OR phone=?)").bind(today(), a.email, a.phone).first();
        if (pp.n >= MAX_PENDING_PER_PERSON) return out({ ok: false, error: "Ya tienes citas pendientes de confirmar. Escríbeme por WhatsApp y lo resolvemos." }, 429);
        if (!(await freeTimes(env, c, a.date, a.dur, 0)).includes(a.time)) return out({ ok: false, error: "Ese horario ya no está disponible. Elige otro." }, 409);
        let id;
        try {
          const r = await env.DB.prepare("INSERT INTO appointments(name,phone,email,service,notes,date,time,dur,status,source,ip,terms) VALUES(?,?,?,?,?,?,?,?,'pendiente','web',?,?)").bind(a.name, a.phone, a.email, a.service, a.notes, a.date, a.time, a.dur, ip, TERMS_VERSION + " · " + new Date().toISOString()).run();
          id = r.meta.last_row_id;
        } catch (e) {
          if (String(e).includes("UNIQUE")) return out({ ok: false, error: "Ese horario ya no está disponible. Elige otro." }, 409);
          throw e;
        }
        if (await lostRace(env, id, a.date)) { await env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(id).run(); return out({ ok: false, error: "Ese horario ya no está disponible. Elige otro." }, 409); }
        const full = { ...a, id };
        const email = await mailPending(env, full, c);
        ctx.waitUntil(mailOwnerNew(env, full, c));
        return out({ ok: true, id, code: code(id), email });
      }
      if (path === "/api/login" && m === "POST") {
        await env.DB.prepare("DELETE FROM login_attempts WHERE ts<?").bind(Date.now() - 9e5).run();
        const f = await env.DB.prepare("SELECT COUNT(*) n FROM login_attempts WHERE ip=?").bind(ip).first();
        if (f.n >= 8) return out({ ok: false, error: "Demasiados intentos. Espera 15 minutos." }, 429);
        const b = await body();
        const fail = async () => { await env.DB.prepare("INSERT INTO login_attempts(ip,ts) VALUES(?,?)").bind(ip, Date.now()).run(); return out({ ok: false, error: "Usuario o contraseña incorrectos" }, 401); };
        if (!env.ADMIN_USER || !env.ADMIN_PASS || !env.SESSION_SECRET) return out({ ok: false, error: "El panel aún no tiene usuario y contraseña configurados en Cloudflare." }, 503);
        if (b.website) { await trapHit(env, ip, "trampa-login"); return fail(); }
        const u = eq(await sha(clean(b.user, 80).toLowerCase()), await sha(String(env.ADMIN_USER).toLowerCase()));
        const p = eq(await sha(String(b.pass ?? "")), await sha(String(env.ADMIN_PASS)));
        if (!u || !p) return fail();
        const exp = String(Date.now() + SESSION_HOURS * 36e5);
        return out({ ok: true, token: exp + "." + (await hmac(sessKey(env), "admin|" + exp)) });
      }

      // ----- panel admin -----
      if (path.startsWith("/api/admin/")) {
        if (!(await authed(req, env))) return out({ ok: false, error: "Tu sesión expiró. Vuelve a entrar." }, 401);
        const rest = path.slice(11);
        if (rest === "appointments" && m === "GET") {
          const from = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("from") || "") ? url.searchParams.get("from") : addDays(today(), -60);
          const { results } = await env.DB.prepare("SELECT id,name,phone,email,service,notes,date,time,dur,status,source,created_at FROM appointments WHERE date>=? ORDER BY date,time").bind(from).all();
          return out({ ok: true, today: today(), items: results || [] });
        }
        if (rest === "slots" && m === "GET") {
          const c = await cfg(env), d = url.searchParams.get("date") || "", dur = Math.max(15, Math.min(480, +url.searchParams.get("dur") || 60));
          if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return out({ ok: true, times: [] });
          return out({ ok: true, times: await freeTimes(env, c, d, dur, +url.searchParams.get("except") || 0) });
        }
        if (rest === "appointments" && m === "POST") {
          const b = await body(), c = await cfg(env), a = readAppt(b, c), err = check(a, c, false);
          if (err) return out({ ok: false, error: err }, 400);
          if (!(await freeTimes(env, c, a.date, a.dur, 0)).includes(a.time) && b.force !== true) return out({ ok: false, error: "Ese horario está ocupado o el servicio no cabe ahí.", busy: true }, 409);
          let id;
          try {
            const r = await env.DB.prepare("INSERT INTO appointments(name,phone,email,service,notes,date,time,dur,status,source) VALUES(?,?,?,?,?,?,?,?,'confirmada','admin')").bind(a.name, a.phone, a.email, a.service, a.notes, a.date, a.time, a.dur).run();
            id = r.meta.last_row_id;
          } catch (e) {
            if (String(e).includes("UNIQUE")) return out({ ok: false, error: "Ya hay otra cita a esa misma hora." }, 409);
            throw e;
          }
          const email = a.email && b.notify !== false ? await mailConfirmed(env, { ...a, id }, c) : "none";
          return out({ ok: true, id, email });
        }
        const mm = rest.match(/^appointments\/(\d+)$/);
        if (mm && m === "PATCH") {
          const old = await env.DB.prepare("SELECT * FROM appointments WHERE id=?").bind(mm[1]).first();
          if (!old) return out({ ok: false, error: "Esa cita ya no existe" }, 404);
          const b = await body(), c = await cfg(env);
          const a = readAppt({ ...old, ...b, dur: b.dur ?? old.dur }, c);
          const st = STATUS.includes(b.status) ? b.status : old.status;
          const err = check(a, c, false);
          if (err) return out({ ok: false, error: err }, 400);
          const moved = a.date !== old.date || a.time !== old.time || a.dur !== old.dur;
          if (ACTIVE.includes(st) && (moved || !ACTIVE.includes(old.status)) && b.force !== true) {
            if (!(await freeTimes(env, c, a.date, a.dur, old.id)).includes(a.time) && !(a.date === old.date && a.time === old.time && a.dur <= old.dur && ACTIVE.includes(old.status)))
              return out({ ok: false, error: "Ese horario está ocupado o el servicio no cabe ahí.", busy: true }, 409);
          }
          try {
            await env.DB.prepare("UPDATE appointments SET name=?,phone=?,email=?,service=?,notes=?,date=?,time=?,dur=?,status=?,reminded=? WHERE id=?").bind(a.name, a.phone, a.email, a.service, a.notes, a.date, a.time, a.dur, st, moved ? 0 : old.reminded, old.id).run();
          } catch (e) {
            if (String(e).includes("UNIQUE")) return out({ ok: false, error: "Ya hay otra cita a esa misma hora." }, 409);
            throw e;
          }
          const full = { ...a, id: old.id };
          let email = "none";
          if (b.notify !== false && a.email) {
            if (st === "confirmada" && old.status !== "confirmada") email = await mailConfirmed(env, full, c);
            else if (st === "cancelada" && old.status !== "cancelada") email = await mailCancelled(env, full, c);
            else if (ACTIVE.includes(st) && (a.date !== old.date || a.time !== old.time)) email = await mailMoved(env, full, c, old);
          }
          return out({ ok: true, email });
        }
        if (mm && m === "DELETE") {
          await env.DB.prepare("DELETE FROM appointments WHERE id=?").bind(mm[1]).run();
          return out({ ok: true });
        }
        if (rest === "config" && m === "GET") {
          const c = await cfg(env);
          return out({ ok: true, config: { ...c, email: owner(env, c) }, resend: !!env.RESEND_API_KEY });
        }
        if (rest === "config" && m === "PUT") {
          const b = await body(), c = await cfg(env);
          const num = (v, lo, hi, d) => { const n = +v; return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
          const services = Array.isArray(b.services) ? b.services.slice(0, 30).map((s) => ({ n: clean(s.n, 80), p: Math.round(num(s.p, 0, 1e4, 0) * 100) / 100, dur: Math.round(num(s.dur, 15, 480, 60) / 15) * 15, d: clean(s.d, 160), k: clean(s.k, 20) })).filter((s) => s.n) : c.services;
          if (!services.length) return out({ ok: false, error: "Deja al menos un servicio" }, 400);
          if (new Set(services.map((s) => s.n.toLowerCase())).size !== services.length) return out({ ok: false, error: "Hay dos servicios con el mismo nombre" }, 400);
          const hours = Array.isArray(b.hours) && b.hours.length === 7 ? b.hours.map((h) => [h[0] ? 1 : 0, num(h[1], 0, 24, 9), num(h[2], 0, 24, 18), num(h[3], 0, 24, 0), num(h[4], 0, 24, 0)]) : c.hours;
          if (hours.some((h) => h[0] && h[2] <= h[1])) return out({ ok: false, error: "En algún día la hora de cierre es antes que la de apertura" }, 400);
          const email = clean(b.email, 120);
          if (email && !validEmail(email)) return out({ ok: false, error: "El correo de avisos no es válido" }, 400);
          const n = { slot: [15, 30, 45, 60].includes(+b.slot) ? +b.slot : c.slot, hours, services, email, wa: clean(b.wa, 20).replace(/\D/g, "") || c.wa, waShow: clean(b.waShow, 30) || c.waShow };
          await env.DB.prepare("INSERT INTO settings(key,value) VALUES('config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").bind(JSON.stringify(n)).run();
          return out({ ok: true });
        }
        if (rest === "backup" && m === "GET") {
          return new Response(JSON.stringify(await exportDb(env), null, 1), { headers: { ...H, "Content-Disposition": 'attachment; filename="madelane-respaldo-' + today() + '.json"' } });
        }
        if (rest === "test-email" && m === "POST") {
          const c = await cfg(env), to = owner(env, c);
          if (!to) return out({ ok: false, error: "No hay correo de avisos configurado" }, 400);
          const r = await mail(env, to, "Prueba de correo - Madelane Nails", shell("<p>¡Los correos de tu sistema de citas funcionan! 💅</p>"), "Los correos de tu sistema de citas funcionan.");
          return out({ ok: r === "sent", email: r, error: r === "none" ? "Falta la clave de Resend (RESEND_API_KEY) en Cloudflare" : r === "failed" ? "Resend rechazó el envío. Revisa que el dominio esté verificado." : undefined });
        }
      }
      return out({ ok: false, error: "No encontrado" }, 404);
    } catch (e) {
      return out({ ok: false, error: "Error del servidor. Intenta de nuevo." }, 500);
    }
  }
};
