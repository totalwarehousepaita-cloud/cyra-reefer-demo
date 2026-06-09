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

app.use(express.json({ limit: '35mb' }));

const INDEX_PATHS = [
  path.join(__dirname, 'index.html'),
  path.join(__dirname, 'public', 'index.html')
];

const KNOWLEDGE_PATHS = [
  path.join(__dirname, 'knowledge_base.json'),
  path.join(__dirname, 'data', 'knowledge_base.json')
];

const PROMPT_PATHS = [
  path.join(__dirname, 'system_prompt.txt'),
  path.join(__dirname, 'data', 'system_prompt.txt')
];

const KNOWLEDGE = readJson(KNOWLEDGE_PATHS, {
  app: 'CYRA Reefer Vision',
  ptiLevels: ['SUPERIOR', 'MEDIA', 'INFERIOR'],
  requiredPPE: ['Casco', 'Guantes', 'Protectores auditivos', 'Botas punta de acero', 'Lentes'],
  reeferRisks: ['Electrocución', 'Golpes y caídas', 'Quemaduras', 'Lesiones oculares'],
  ptiRules: [
    'El PTI se realiza para garantizar el correcto funcionamiento de la unidad reefer.',
    'Superior: panel evaporadores, pernos, tuercas y damper de ventilación.',
    'Media: condensador, control box, contactores, resistencias, software, RCD, tuberías y compresor.',
    'Inferior: cable power, plug, guardacable, manguera de drenaje, base compresor y motor condensador.'
  ]
});

const SYSTEM_PROMPT = readText(
  PROMPT_PATHS,
  'Eres el motor CYRA IA de CYRA Reefer Vision. Analiza imágenes PTI de contenedores reefer, clasifica hallazgos por SUPERIOR, MEDIA e INFERIOR, marca daños con overlays y responde solo JSON válido.'
);

app.use(express.static(__dirname));
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) app.use(express.static(publicPath));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'CYRA Reefer Vision',
    aiConfigured: Boolean(GEMINI_API_KEY),
    model: GEMINI_MODEL,
    indexFound: Boolean(firstExisting(INDEX_PATHS)),
    knowledgeFound: Boolean(firstExisting(KNOWLEDGE_PATHS)),
    promptFound: Boolean(firstExisting(PROMPT_PATHS))
  });
});

app.post('/api/analyze-inspection', async (req, res) => {
  const { images = [], sections = [] } = req.body || {};

  try {
    if (!Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: 'Debe enviar images.' });
    }

    if (!GEMINI_API_KEY) {
      return res.json({ source: 'fallback-no-api-key', ...fallbackInspection(images) });
    }

    const result = await callCyraInspection(images, sections);
    const normalized = normalizeInspection(result, images);

    return res.json({
      source: 'cyra-ia',
      ...normalized
    });
  } catch (error) {
    console.error('CYRA IA inspection error:', error);

    return res.json({
      source: 'fallback-error',
      error: error.message,
      ...fallbackInspection(images)
    });
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

    const result = await callCyraEpp(images);
    const normalized = normalizeEpp(result, images);

    return res.json({
      source: 'cyra-ia',
      ...normalized
    });
  } catch (error) {
    console.error('CYRA IA EPP error:', error);

    return res.json({
      source: 'fallback-error',
      error: error.message,
      ...fallbackEPP(images)
    });
  }
});

async function callCyraInspection(images, sections) {
  const parts = [
    {
      text: `${SYSTEM_PROMPT}

BASE DOCUMENTAL CYRA:
${JSON.stringify(KNOWLEDGE)}

TAREA:
Analiza TODAS las imágenes juntas. El usuario ya no separa manualmente por superior, media e inferior.

Debes:
1. Detectar daños visibles en la imagen completa.
2. Clasificar cada hallazgo por nivel: SUPERIOR, MEDIA o INFERIOR.
3. Asociar cada hallazgo con imageIndex.
4. Colocar overlay en porcentajes de la imagen completa: x, y, w, h.
5. Considerar checklist PTI y riesgos técnicos.
6. Responder SOLO JSON válido.

NIVELES:
${JSON.stringify(sections)}

SCHEMA:
{
  "score": number,
  "status": "Operativo | Operativo con observaciones | Requiere reparación | Requiere PTI",
  "sections": [
    {
      "code": "SUPERIOR | MEDIA | INFERIOR",
      "zone": "Superior | Media | Inferior",
      "score": number,
      "status": "Operativo | Operativo con observaciones | Requiere reparación | Requiere PTI",
      "findings": [
        {
          "section": "SUPERIOR | MEDIA | INFERIOR",
          "zone": "Superior | Media | Inferior",
          "component": "texto",
          "hallazgo": "texto corto",
          "estado": "OK | Observado | Crítico | DMG | Requiere limpieza | Requiere reparación | Requiere PTI | No visible | Imagen no válida",
          "severity": "Leve | Media | Severa",
          "risk": "texto",
          "action": "texto",
          "confidence": number,
          "damage": "MISSING | DENTED | CONTAMINATED | LEAK | BURNED | DMG",
          "qty": number,
          "imageIndex": number,
          "overlay": { "x": number, "y": number, "w": number, "h": number }
        }
      ]
    }
  ]
}`
    }
  ];

  for (const image of images.slice(0, 10)) {
    const inline = dataUrlToInlineData(image.dataUrl || image.src);
    if (inline) parts.push({ inline_data: inline });
  }

  const response = await fetch(aiProviderUrl(), {
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
    throw new Error(`CYRA IA API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return extractJson(data);
}

async function callCyraEpp(images) {
  const parts = [
    {
      text: `${SYSTEM_PROMPT}

Analiza EPP del operador.
EPP requeridos: casco, guantes, protectores auditivos, botas punta de acero y lentes.

Devuelve SOLO JSON:
{
  "score": number,
  "status": "Cumple EPP | Cumple con observaciones | Alerta de seguridad",
  "findings": [
    {
      "component": "Casco | Guantes | Protectores auditivos | Lentes | Botas punta de acero | EPP completo",
      "hallazgo": "texto",
      "estado": "OK | Observado | Crítico",
      "severity": "Leve | Media | Severa",
      "risk": "texto",
      "action": "texto",
      "confidence": number,
      "imageIndex": number,
      "overlay": { "x": number, "y": number, "w": number, "h": number }
    }
  ]
}`
    }
  ];

  for (const image of images.slice(0, 10)) {
    const inline = dataUrlToInlineData(image.dataUrl || image.src);
    if (inline) parts.push({ inline_data: inline });
  }

  const response = await fetch(aiProviderUrl(), {
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
    throw new Error(`CYRA IA API ${response.status}: ${text.slice(0, 500)}`);
  }

  const data = await response.json();
  return extractJson(data);
}

function normalizeInspection(raw, images) {
  let sections = Array.isArray(raw.sections) ? raw.sections : [];

  if (!sections.length && Array.isArray(raw.findings)) {
    sections = groupFindings(raw.findings);
  }

  sections = sections.map((section) => {
    const code = normalizeLevel(section.code || section.section || section.zone);
    const findings = Array.isArray(section.findings) ? section.findings : [];

    const normalizedFindings = findings.map((f) => normalizeFinding(f, code, images));
    const score = clampNumber(section.score ?? calculateScore(normalizedFindings), 0, 100);

    return {
      code,
      zone: levelToZone(code),
      score,
      status: section.status || statusFromScore(score, normalizedFindings.filter((f) => f.estado === 'Crítico').length),
      findings: normalizedFindings
    };
  });

  const all = sections.flatMap((s) => s.findings);

  const score = clampNumber(
    raw.score ?? (
      sections.length
        ? Math.round(sections.reduce((sum, s) => sum + s.score, 0) / sections.length)
        : calculateScore(all)
    ),
    0,
    100
  );

  return {
    score,
    status: raw.status || statusFromScore(score, all.filter((f) => f.estado === 'Crítico').length),
    sections,
    findings: all,
    detectionsByImage: images.map((_img, idx) => all.filter((f) => f.imageIndex === idx))
  };
}

function normalizeEpp(raw, images) {
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

  const alerts = normalizedFindings.filter((f) => f.estado !== 'OK').length;
  const score = clampNumber(raw.score ?? Math.max(20, 100 - alerts * 22), 0, 100);

  return {
    score,
    status: raw.status || (score >= 95 ? 'Cumple EPP' : score >= 75 ? 'Cumple con observaciones' : 'Alerta de seguridad'),
    findings: normalizedFindings,
    detectionsByImage: images.map((_img, idx) => normalizedFindings.filter((f) => f.imageIndex === idx)),
    compliant: normalizedFindings.filter((f) => f.estado === 'OK').length,
    alerts
  };
}

function normalizeFinding(f, code, images) {
  return {
    section: normalizeLevel(f.section || f.zone || code),
    zone: levelToZone(normalizeLevel(f.section || f.zone || code)),
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
  };
}

function fallbackInspection(images) {
  const sections = [
    {
      code: 'SUPERIOR',
      zone: 'Superior',
      findings: [
        {
          section: 'SUPERIOR',
          zone: 'Superior',
          component: 'Panel evaporadores',
          hallazgo: 'Panel evaporadores con pernos faltantes',
          estado: 'DMG',
          severity: 'Media',
          risk: 'Puede generar vibración o pérdida de sujeción',
          action: 'Completar pernos y validar fijación',
          confidence: 90,
          damage: 'MISSING',
          qty: 1,
          imageIndex: 0,
          overlay: { x: 18, y: 10, w: 56, h: 24 }
        }
      ]
    },
    {
      code: 'MEDIA',
      zone: 'Media',
      findings: [
        {
          section: 'MEDIA',
          zone: 'Media',
          component: 'Condensador',
          hallazgo: 'Condensador con suciedad y obstrucción',
          estado: 'Requiere limpieza',
          severity: 'Media',
          risk: 'Puede afectar intercambio térmico',
          action: 'Realizar limpieza técnica',
          confidence: 92,
          damage: 'CONTAMINATED',
          qty: 1,
          imageIndex: 0,
          overlay: { x: 19, y: 36, w: 35, h: 39 }
        },
        {
          section: 'MEDIA',
          zone: 'Media',
          component: 'Control Box',
          hallazgo: 'Puerta de Control Box con sellado deficiente',
          estado: 'Requiere reparación',
          severity: 'Media',
          risk: 'Ingreso de humedad al componente eléctrico',
          action: 'Corregir sellado y revalidar',
          confidence: 89,
          damage: 'DMG',
          qty: 1,
          imageIndex: 0,
          overlay: { x: 61, y: 30, w: 23, h: 34 }
        }
      ]
    },
    {
      code: 'INFERIOR',
      zone: 'Inferior',
      findings: [
        {
          section: 'INFERIOR',
          zone: 'Inferior',
          component: 'Cable power',
          hallazgo: 'Cable de alimentación con peladura visible',
          estado: 'Crítico',
          severity: 'Severa',
          risk: 'Riesgo eléctrico. No energizar la unidad',
          action: 'Reparar o reemplazar cable',
          confidence: 95,
          damage: 'DMG',
          qty: 1,
          imageIndex: 0,
          overlay: { x: 15, y: 74, w: 22, h: 16 }
        }
      ]
    }
  ];

  const safeSections = sections.map((section, sectionIndex) => {
    const findings = section.findings.map((f, idx) => ({
      ...f,
      imageIndex: Math.min((idx + sectionIndex) % Math.max(1, images.length), images.length - 1)
    }));

    const score = calculateScore(findings);

    return {
      ...section,
      score,
      status: statusFromScore(score, findings.filter((f) => f.estado === 'Crítico').length),
      findings
    };
  });

  const all = safeSections.flatMap((s) => s.findings);
  const score = Math.round(safeSections.reduce((sum, s) => sum + s.score, 0) / safeSections.length);

  return {
    score,
    status: statusFromScore(score, all.filter((f) => f.estado === 'Crítico').length),
    sections: safeSections,
    findings: all,
    detectionsByImage: images.map((_img, idx) => all.filter((f) => f.imageIndex === idx))
  };
}

function fallbackEPP(images) {
  const findings = [
    {
      component: 'EPP completo',
      hallazgo: 'Validación EPP generada por respaldo local',
      estado: 'Observado',
      severity: 'Media',
      risk: 'Confirmar visualmente todos los EPP antes de iniciar',
      action: 'Verificar casco, guantes, lentes, botas y protectores auditivos',
      confidence: 80,
      imageIndex: 0,
      overlay: { x: 25, y: 8, w: 50, h: 80 }
    }
  ];

  return {
    score: 78,
    status: 'Cumple con observaciones',
    findings,
    detectionsByImage: images.map((_img, idx) => findings.filter((f) => f.imageIndex === idx)),
    compliant: 0,
    alerts: 1
  };
}

function groupFindings(findings) {
  const groups = { SUPERIOR: [], MEDIA: [], INFERIOR: [] };

  for (const f of findings) {
    const level = normalizeLevel(f.section || f.zone || 'MEDIA');
    groups[level].push(f);
  }

  return Object.entries(groups)
    .filter(([, items]) => items.length)
    .map(([code, items]) => ({
      code,
      zone: levelToZone(code),
      findings: items
    }));
}

function normalizeLevel(value = '') {
  const v = String(value).toUpperCase();

  if (v.includes('SUPERIOR') || v.includes('UPPER') || v.includes('EVAPOR')) {
    return 'SUPERIOR';
  }

  if (v.includes('INFERIOR') || v.includes('LOWER') || v.includes('CABLE') || v.includes('PLUG')) {
    return 'INFERIOR';
  }

  return 'MEDIA';
}

function levelToZone(code) {
  if (code === 'SUPERIOR') return 'Superior';
  if (code === 'INFERIOR') return 'Inferior';
  return 'Media';
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

function statusFromScore(score, criticalCount = 0) {
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

function dataUrlToInlineData(dataUrl = '') {
  const match = String(dataUrl).match(/^data:(image\/[^;]+);base64,(.+)$/);

  if (!match) return null;

  return {
    mime_type: match[1],
    data: match[2]
  };
}

function extractJson(data) {
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('\n') || '';

  if (!text.trim()) {
    throw new Error('CYRA IA no devolvió texto.');
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    const match = text.match(/\{[\s\S]*\}/);

    if (!match) {
      throw new Error('No se encontró JSON en la respuesta de CYRA IA.');
    }

    return JSON.parse(match[0]);
  }
}

function aiProviderUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
}

function firstExisting(paths) {
  return paths.find((p) => fs.existsSync(p));
}

function readText(paths, fallback = '') {
  const file = firstExisting(paths);

  if (!file) return fallback;

  try {
    return fs.readFileSync(file, 'utf8');
  } catch (_error) {
    return fallback;
  }
}

function readJson(paths, fallback = {}) {
  const file = firstExisting(paths);

  if (!file) return fallback;

  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_error) {
    return fallback;
  }
}

app.get('*', (_req, res) => {
  const indexPath = firstExisting(INDEX_PATHS);

  if (!indexPath) {
    return res.status(404).send('No se encontró index.html en la raíz ni en public/index.html');
  }

  return res.sendFile(indexPath);
});

app.listen(PORT, () => {
  console.log(`CYRA Reefer Vision running on port ${PORT}`);
  console.log(`CYRA IA configured: ${Boolean(GEMINI_API_KEY)} | Model: ${GEMINI_MODEL}`);
});
