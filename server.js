import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

const KNOWLEDGE = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'knowledge_base.json'), 'utf8'));
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, 'data', 'system_prompt.txt'), 'utf8');

app.use(express.json({ limit: '35mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'CYRA Reefer Vision',
    geminiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL
  });
});

app.post('/api/analyze-section', async (req, res) => {
  const { section, images = [], checklist = [] } = req.body || {};
  try {
    if (!section || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Debe enviar section e images.' });
    }

    if (!GEMINI_API_KEY) {
      return res.json({ source: 'fallback-no-api-key', ...fallbackSection(section, images, checklist) });
    }

    const result = await callGeminiForSection(section, images, checklist);
    res.json({ source: 'gemini', ...normalizeSectionResult(result, section, images) });
  } catch (error) {
    console.error('Gemini section error:', error);
    res.json({ source: 'fallback-error', error: error.message, ...fallbackSection(section, images, checklist) });
  }
});

app.post('/api/analyze-epp', async (req, res) => {
  const { images = [] } = req.body || {};
  try {
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Debe enviar images.' });
    }

    if (!GEMINI_API_KEY) {
      return res.json({ source: 'fallback-no-api-key', ...fallbackEPP(images) });
    }

    const result = await callGeminiForEPP(images);
    res.json({ source: 'gemini', ...normalizeEPPResult(result, images) });
  } catch (error) {
    console.error('Gemini EPP error:', error);
    res.json({ source: 'fallback-error', error: error.message, ...fallbackEPP(images) });
  }
});

async function callGeminiForSection(section, images, checklist) {
  const parts = [
    {
      text: `${SYSTEM_PROMPT}\n\nBASE DOCUMENTAL CYRA:\n${JSON.stringify(KNOWLEDGE)}\n\nTAREA:\nAnaliza las imágenes del nivel PTI recibido y responde JSON válido con el schema definido.\n\nNIVEL ACTUAL:\n${JSON.stringify(section)}\n\nCHECKLIST / ESTADO USUARIO:\n${JSON.stringify(checklist)}\n\nINSTRUCCIONES DE SALIDA:\n- Devuelve solo JSON.\n- Usa findings técnicos cortos.\n- Usa imageIndex para asociar cada hallazgo a la imagen.\n- Si no hay hallazgos, devuelve score alto, status Operativo y findings vacío.\n- Si una imagen no es útil, genera hallazgo Imagen no válida.\n- overlay debe estar en porcentajes de la imagen.`
    }
  ];

  for (const image of images.slice(0, 10)) {
    const inline = dataUrlToInlineData(image.dataUrl || image.src);
    if (inline) parts.push({ inline_data: inline });
  }

  const response = await fetch(geminiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.15,
        topP: 0.8,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return extractJsonFromGemini(data);
}

async function callGeminiForEPP(images) {
  const parts = [
    {
      text: `${SYSTEM_PROMPT}\n\nBASE DOCUMENTAL CYRA:\n${JSON.stringify({ requiredPPE: KNOWLEDGE.requiredPPE, reeferRisks: KNOWLEDGE.reeferRisks, preventiveActions: KNOWLEDGE.preventiveActions })}\n\nTAREA:\nAnaliza visualmente las fotos del operador y determina cumplimiento EPP.\n\nEPP requeridos: casco, guantes, protectores auditivos, botas punta de acero y lentes.\n\nDevuelve solo JSON con este schema:\n{ "score": number, "status": "Cumple EPP | Cumple con observaciones | Alerta de seguridad", "findings": [{"component":"Casco|Guantes|Protectores auditivos|Lentes|Botas punta de acero|EPP completo", "hallazgo":"texto", "estado":"OK|Observado|Crítico", "severity":"Leve|Media|Severa", "risk":"texto", "action":"texto", "confidence": number, "imageIndex": number, "overlay": {"x":number,"y":number,"w":number,"h":number}}] }`
    }
  ];

  for (const image of images.slice(0, 10)) {
    const inline = dataUrlToInlineData(image.dataUrl || image.src);
    if (inline) parts.push({ inline_data: inline });
  }

  const response = await fetch(geminiUrl(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature: 0.12,
        topP: 0.8,
        responseMimeType: 'application/json'
      }
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gemini API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return extractJsonFromGemini(data);
}

function geminiUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
}

function dataUrlToInlineData(dataUrl = '') {
  const match = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mime_type: match[1], data: match[2] };
}

function extractJsonFromGemini(data) {
  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('\n') || '';
  if (!text.trim()) throw new Error('Gemini no devolvió texto.');
  try {
    return JSON.parse(text);
  } catch (_e) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No se encontró JSON en la respuesta de Gemini.');
    return JSON.parse(match[0]);
  }
}

function normalizeSectionResult(raw, section, images) {
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  const normalizedFindings = findings.map((f, i) => ({
    zone: String(f.zone || section.zone || section.code || 'Reefer'),
    section: String(f.section || section.code || 'PTI'),
    component: String(f.component || 'Componente'),
    hallazgo: String(f.hallazgo || f.finding || 'Hallazgo visual'),
    estado: String(f.estado || f.status || 'Observado'),
    severity: String(f.severity || 'Media'),
    risk: String(f.risk || 'Requiere validación técnica'),
    action: String(f.action || 'Revisar y revalidar con evidencia'),
    confidence: clampNumber(f.confidence ?? 85, 0, 100),
    damage: String(f.damage || inferDamage(f.hallazgo || f.finding || '')),
    qty: f.qty || f.quantity || 1,
    imageIndex: clampNumber(f.imageIndex ?? f.image_index ?? 0, 0, Math.max(0, images.length - 1)),
    overlay: normalizeOverlay(f.overlay)
  }));

  const detectionsByImage = images.map((_img, idx) => normalizedFindings.filter(f => f.imageIndex === idx));
  const criticalCount = normalizedFindings.filter(f => ['Crítico', 'Requiere PTI'].includes(f.estado)).length;
  const score = clampNumber(raw.score ?? calculateScore(normalizedFindings), 0, 100);
  const status = raw.status || statusFromScore(score, criticalCount);

  return { score, status, findings: normalizedFindings, detectionsByImage };
}

function normalizeEPPResult(raw, images) {
  const findings = Array.isArray(raw.findings) ? raw.findings : [];
  const normalizedFindings = findings.map((f) => ({
    component: String(f.component || 'EPP'),
    hallazgo: String(f.hallazgo || f.finding || 'Validación EPP'),
    estado: String(f.estado || f.status || 'Observado'),
    severity: String(f.severity || 'Media'),
    risk: String(f.risk || 'Riesgo de seguridad'),
    action: String(f.action || 'Corregir antes de iniciar la labor'),
    confidence: clampNumber(f.confidence ?? 85, 0, 100),
    imageIndex: clampNumber(f.imageIndex ?? f.image_index ?? 0, 0, Math.max(0, images.length - 1)),
    overlay: normalizeOverlay(f.overlay)
  }));
  const alerts = normalizedFindings.filter(f => f.estado !== 'OK').length;
  const score = clampNumber(raw.score ?? Math.max(20, 100 - alerts * 22), 0, 100);
  return {
    score,
    status: raw.status || (score >= 95 ? 'Cumple EPP' : score >= 75 ? 'Cumple con observaciones' : 'Alerta de seguridad'),
    findings: normalizedFindings,
    detectionsByImage: images.map((_img, idx) => normalizedFindings.filter(f => f.imageIndex === idx)),
    compliant: normalizedFindings.filter(f => f.estado === 'OK').length,
    alerts
  };
}

function fallbackSection(section, images, checklist) {
  const baseFindings = Array.isArray(section.findings) ? section.findings : [];
  const findings = baseFindings.slice(0, Math.max(1, images.length)).map((f, idx) => ({
    zone: section.zone || section.code || 'Reefer',
    section: section.code || 'PTI',
    component: f.component || 'Componente',
    hallazgo: f.hallazgo || 'Hallazgo visual simulado',
    estado: f.estado || 'Observado',
    severity: f.severity || 'Media',
    risk: f.risk || 'Requiere validación técnica',
    action: f.action || 'Revisar y revalidar con evidencia',
    confidence: f.confidence || 88,
    damage: f.damage || inferDamage(f.hallazgo || ''),
    qty: f.qty || 1,
    imageIndex: Math.min(idx, images.length - 1),
    overlay: normalizeOverlay(f.overlay)
  }));

  (checklist || []).forEach((status, idx) => {
    if (['DMG', 'Crítico', 'Observado', 'No visible'].includes(status)) {
      const cp = section.checklist?.[idx] || `Punto ${idx + 1}`;
      const label = typeof cp === 'string' ? cp : cp.label;
      const component = typeof cp === 'string' ? section.components?.[idx] : cp.component;
      findings.push({
        zone: section.zone || section.code || 'Reefer',
        section: section.code || 'PTI',
        component: component || 'Componente',
        hallazgo: status === 'No visible' ? `No visible: ${label}` : label,
        estado: status === 'DMG' ? 'DMG' : status,
        severity: status === 'Crítico' ? 'Severa' : 'Media',
        risk: status === 'Crítico' ? 'Compromete operación o seguridad' : 'Puede afectar conformidad PTI',
        action: status === 'Crítico' ? 'Atender antes de energizar o liberar' : 'Corregir y revalidar con evidencia',
        confidence: 82,
        damage: inferDamage(label),
        qty: 1,
        imageIndex: 0,
        overlay: { x: 30, y: 30, w: 35, h: 25 }
      });
    }
  });

  const unique = dedupe(findings);
  const score = calculateScore(unique);
  return {
    score,
    status: statusFromScore(score, unique.filter(f => f.estado === 'Crítico').length),
    findings: unique,
    detectionsByImage: images.map((_img, idx) => unique.filter(f => f.imageIndex === idx))
  };
}

function fallbackEPP(images) {
  const scenarios = [
    [{ component: 'Guantes', hallazgo: 'Operador sin guantes', estado: 'Crítico', severity: 'Severa', risk: 'Riesgo de lesión en manos', action: 'Colocar guantes antes de iniciar', confidence: 94, overlay: { x: 35, y: 48, w: 28, h: 18 } }],
    [{ component: 'Casco', hallazgo: 'Operador sin casco', estado: 'Crítico', severity: 'Severa', risk: 'Riesgo de lesión craneal', action: 'Colocar casco antes de ingresar a zona operativa', confidence: 95, overlay: { x: 35, y: 8, w: 28, h: 18 } }],
    [{ component: 'EPP completo', hallazgo: 'Operador con EPP completo', estado: 'OK', severity: 'Leve', risk: 'Sin riesgo observado', action: 'Apto para labores de inspección', confidence: 97, overlay: { x: 25, y: 8, w: 50, h: 80 } }]
  ];
  const findings = images.flatMap((_img, idx) => scenarios[idx % scenarios.length].map(f => ({ ...f, imageIndex: idx })));
  const alerts = findings.filter(f => f.estado !== 'OK').length;
  const score = Math.max(20, 100 - alerts * 28);
  return {
    score,
    status: score >= 95 ? 'Cumple EPP' : score >= 75 ? 'Cumple con observaciones' : 'Alerta de seguridad',
    findings,
    detectionsByImage: images.map((_img, idx) => findings.filter(f => f.imageIndex === idx)),
    compliant: findings.filter(f => f.estado === 'OK').length,
    alerts
  };
}

function calculateScore(findings) {
  let score = 100;
  for (const f of findings) {
    if (f.estado === 'Crítico') score -= 25;
    else if (f.estado === 'Requiere PTI') score -= 20;
    else if (f.estado === 'Requiere reparación' || f.estado === 'DMG') score -= 14;
    else if (f.estado === 'Requiere limpieza') score -= 10;
    else if (f.estado === 'Observado') score -= 8;
    else if (f.estado === 'Imagen no válida' || f.estado === 'No visible') score -= 6;
  }
  return clampNumber(score, 15, 100);
}

function statusFromScore(score, criticalCount) {
  if (criticalCount > 1 || score < 50) return 'Requiere PTI';
  if (criticalCount === 1 || score < 70) return 'Requiere reparación';
  if (score < 90) return 'Operativo con observaciones';
  return 'Operativo';
}

function inferDamage(text = '') {
  const t = String(text).toLowerCase();
  if (/missing|faltant|incomplet/.test(t)) return 'MISSING';
  if (/fuga|aceite|leak/.test(t)) return 'LEAK';
  if (/quem|burn/.test(t)) return 'BURNED';
  if (/suci|contamin|obstru|salitre|grasa/.test(t)) return 'CONTAMINATED';
  if (/golpe|aboll|deform|dented/.test(t)) return 'DENTED';
  return 'DMG';
}

function normalizeOverlay(overlay = {}) {
  return {
    x: clampNumber(overlay.x ?? 20, 0, 85),
    y: clampNumber(overlay.y ?? 20, 0, 85),
    w: clampNumber(overlay.w ?? 35, 8, 75),
    h: clampNumber(overlay.h ?? 22, 8, 75)
  };
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function dedupe(items) {
  const map = new Map();
  for (const item of items) {
    const key = [item.section, item.component, item.hallazgo, item.estado].join('|');
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`CYRA Reefer Vision running on http://localhost:${PORT}`);
  console.log(`Gemini configured: ${Boolean(GEMINI_API_KEY)} | Model: ${GEMINI_MODEL}`);
});
