# CYRA Reefer Vision · Gemini Agent Demo

Demo SaaS empresarial para inspección visual PTI de contenedores reefer, evaluación EPP del operador y generación de hallazgos técnicos usando Gemini.

## Qué incluye

- Frontend HTML completo en `public/index.html`.
- Backend Node.js + Express en `server.js`.
- Conexión a Gemini mediante REST `generateContent`.
- Base documental CYRA en `data/knowledge_base.json`.
- Prompt técnico del agente en `data/system_prompt.txt`.
- Documentos fuente en `docs/`.
- Fallback local si no hay API key o si Gemini no responde.

## Flujo funcional

1. Inicio de sesión demo.
2. Inspección PTI por nivel:
   - Datos
   - Superior
   - Media
   - Inferior
3. Carga de imágenes por nivel.
4. Envío de imágenes al agente Gemini.
5. Respuesta con:
   - Score
   - Estado final
   - Hallazgos
   - Severidad
   - Riesgo
   - Acción recomendada
   - Overlay para señalar el daño sobre la imagen
6. Evaluación EPP del operador.
7. Resultados y reporte.

## Instalación local

```bash
npm install
cp .env.example .env
npm start
```

Luego abre:

```text
http://localhost:3000
```

## Configurar Gemini

Edita `.env`:

```env
GEMINI_API_KEY=TU_API_KEY_DE_GEMINI
GEMINI_MODEL=gemini-2.5-flash
PORT=3000
```

Puedes obtener la API key desde Google AI Studio.

## Deploy en Render

1. Sube esta carpeta a GitHub.
2. En Render crea un nuevo **Web Service**.
3. Conecta el repositorio.
4. Configura:
   - Build command: `npm install`
   - Start command: `npm start`
5. Agrega variable de entorno:
   - `GEMINI_API_KEY`
   - opcional: `GEMINI_MODEL=gemini-2.5-flash`
6. Deploy.

## Notas técnicas

- El backend recibe imágenes como Data URL Base64 desde el navegador.
- El backend convierte cada imagen a `inline_data` para Gemini.
- El prompt fuerza salida JSON para poder pintar resultados en la UI.
- Si Gemini no responde, se ejecuta un fallback local para mantener la demo funcional.

## Estructura

```text
cyra_gemini_package/
├── data/
│   ├── knowledge_base.json
│   └── system_prompt.txt
├── docs/
│   ├── CHECK LIST PTI WEB-APP.xlsx
│   ├── RUTA PTI.pdf
│   └── Secciones de Puntos PTI.xlsx
├── public/
│   └── index.html
├── .env.example
├── .gitignore
├── package.json
├── README.md
└── server.js
```
