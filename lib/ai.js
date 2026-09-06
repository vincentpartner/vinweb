// Anbindung an die beiden KI-Anbieter.
//
// Nach aussen sieht beides gleich aus: Modelle auflisten und einen Chat streamen.
// Die Unterschiede zwischen Claude und ChatGPT stecken nur in dieser Datei.

import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { schluesselHolen } from './keys.js'

// Falls die Modell-Liste nicht abrufbar ist (kein Netz, alter Schlüssel),
// zeigen wir wenigstens die bekannten Modelle an.
const CLAUDE_FALLBACK = [
  { id: 'claude-opus-5', name: 'Claude Opus 5' },
  { id: 'claude-sonnet-5', name: 'Claude Sonnet 5' },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
]

// Preis je 1 Mio. Token (Eingabe/Ausgabe) – hilft bei der Modellwahl.
const CLAUDE_PREISE = {
  'claude-fable-5': [10, 50],
  'claude-opus-5': [5, 25],
  'claude-opus-4-8': [5, 25],
  'claude-opus-4-7': [5, 25],
  'claude-opus-4-6': [5, 25],
  'claude-sonnet-5': [3, 15],
  'claude-sonnet-4-6': [3, 15],
  'claude-haiku-4-5': [1, 5],
}

// Modelle, die für Textarbeit nicht taugen (Sprache, Bilder, Einbettungen …).
const OPENAI_AUSSCHLUSS = /audio|realtime|transcribe|tts|embedding|moderation|image|dall|whisper|sora|codex-mini/i

async function anthropicClient () {
  const schluessel = await schluesselHolen('anthropic')
  if (!schluessel) throw new Error('Kein Claude-Schlüssel hinterlegt.')
  return new Anthropic({ apiKey: schluessel })
}

async function openaiClient () {
  const schluessel = await schluesselHolen('openai')
  if (!schluessel) throw new Error('Kein OpenAI-Schlüssel hinterlegt.')
  return new OpenAI({ apiKey: schluessel })
}

// ---------------------------------------------------------------------------
// Modelle auflisten
// ---------------------------------------------------------------------------

export async function modelleHolen (anbieter) {
  if (anbieter === 'anthropic') {
    try {
      const client = await anthropicClient()
      const antwort = await client.models.list({ limit: 100 })
      const liste = antwort.data.map(m => ({
        id: m.id,
        name: m.display_name || m.id,
        // Datums-Endungen wie -20251101 für die Preissuche abstreifen.
        preis: CLAUDE_PREISE[m.id] || CLAUDE_PREISE[m.id.replace(/-\d{8}$/, '')] || null,
        erschienen: m.created_at || null,
      }))
      // Neuste zuerst – so steht das aktuellste Modell immer oben.
      liste.sort((a, b) => String(b.erschienen || '').localeCompare(String(a.erschienen || '')))
      return liste.length ? liste : CLAUDE_FALLBACK
    } catch (e) {
      if (/Schlüssel/.test(e.message)) throw e
      return CLAUDE_FALLBACK
    }
  }

  if (anbieter === 'openai') {
    const client = await openaiClient()
    const antwort = await client.models.list()
    return antwort.data
      .filter(m => /^(gpt|o\d)/i.test(m.id) && !OPENAI_AUSSCHLUSS.test(m.id))
      // Datierte Doppelgänger (gpt-5.5-2026-04-23 neben gpt-5.5) ausblenden –
      // der undatierte Name zeigt immer auf den aktuellen Stand.
      .filter(m => !/-\d{4}-\d{2}-\d{2}$/.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map(m => ({
        id: m.id,
        name: m.id,
        preis: null,
        erschienen: m.created ? new Date(m.created * 1000).toISOString() : null,
      }))
  }

  throw new Error('Unbekannter Anbieter.')
}

// ---------------------------------------------------------------------------
// Nachrichten umformen
// ---------------------------------------------------------------------------

// Unser Format:  { rolle: 'user'|'assistant', text, bilder: [{ mediaType, base64 }] }

function fuerClaude (nachrichten) {
  return nachrichten.map(n => {
    if (!n.bilder?.length) return { role: n.rolle, content: n.text }
    const inhalt = n.bilder.map(b => ({
      type: 'image',
      source: { type: 'base64', media_type: b.mediaType, data: b.base64 },
    }))
    inhalt.push({ type: 'text', text: n.text })
    return { role: n.rolle, content: inhalt }
  })
}

function fuerOpenAI (nachrichten) {
  return nachrichten.map(n => {
    if (!n.bilder?.length) return { role: n.rolle, content: n.text }
    const inhalt = n.bilder.map(b => ({
      type: 'image_url',
      image_url: { url: `data:${b.mediaType};base64,${b.base64}` },
    }))
    inhalt.push({ type: 'text', text: n.text })
    return { role: n.rolle, content: inhalt }
  })
}

// ---------------------------------------------------------------------------
// Chat streamen
// ---------------------------------------------------------------------------

/**
 * Ruft die KI auf und liefert den Text stückweise über onText zurück.
 * @returns {Promise<{text:string, verbrauch:object|null}>}
 */
export async function chatStreamen ({ anbieter, modell, system, nachrichten, onText, onVerbrauch, signal }) {
  let gesamt = ''
  const sammeln = (stueck) => {
    if (!stueck) return
    gesamt += stueck
    onText?.(stueck)
  }

  if (anbieter === 'anthropic') {
    const client = await anthropicClient()
    const strom = client.messages.stream({
      model: modell,
      max_tokens: 64000,
      system,
      messages: fuerClaude(nachrichten),
    }, { signal })
    strom.on('text', sammeln)
    // Anthropic meldet den Verbrauch schon WÄHREND des Streams:
    // message_start bringt die Eingabe-Token, message_delta zählt die Ausgabe hoch.
    let einTokens = null
    strom.on('streamEvent', (ev) => {
      if (ev.type === 'message_start') {
        einTokens = ev.message?.usage?.input_tokens ?? null
        onVerbrauch?.({ ein: einTokens, aus: 0, geschaetzt: false })
      } else if (ev.type === 'message_delta' && ev.usage?.output_tokens != null) {
        onVerbrauch?.({ ein: einTokens, aus: ev.usage.output_tokens, geschaetzt: false })
      }
    })
    const fertig = await strom.finalMessage()

    if (fertig.stop_reason === 'refusal') {
      throw new Error('Das Modell hat die Anfrage abgelehnt: '
        + (fertig.stop_details?.explanation || 'kein Grund angegeben'))
    }
    if (fertig.stop_reason === 'max_tokens') {
      throw new Error('Die Antwort war zu lang und wurde abgeschnitten – es wurde nichts geschrieben. '
        + 'Bitte die Aufgabe in kleinere Schritte teilen (weniger Dateien pro Auftrag). '
        + 'Serienänderungen über viele Seiten erledigt besser der Produktions-Build.')
    }
    return {
      text: gesamt,
      verbrauch: {
        ein: fertig.usage?.input_tokens ?? null,
        aus: fertig.usage?.output_tokens ?? null,
      },
    }
  }

  if (anbieter === 'openai') {
    const client = await openaiClient()
    const strom = await client.chat.completions.create({
      model: modell,
      messages: [{ role: 'system', content: system }, ...fuerOpenAI(nachrichten)],
      stream: true,
      stream_options: { include_usage: true },
    }, { signal })
    let verbrauch = null
    for await (const teil of strom) {
      sammeln(teil.choices?.[0]?.delta?.content)
      // OpenAI liefert die echte Zählung erst ganz am Ende –
      // unterwegs schätzen wir grob über die Textlänge (~3,5 Zeichen je Token).
      onVerbrauch?.({ ein: null, aus: Math.round(gesamt.length / 3.5), geschaetzt: true })
      if (teil.usage) {
        verbrauch = { ein: teil.usage.prompt_tokens, aus: teil.usage.completion_tokens }
        onVerbrauch?.({ ...verbrauch, geschaetzt: false })
      }
    }
    return { text: gesamt, verbrauch }
  }

  throw new Error('Unbekannter Anbieter.')
}

// Macht aus technischen Fehlermeldungen etwas Lesbares.
export function fehlerText (e) {
  const status = e?.status ?? e?.response?.status
  if (status === 401) return 'Der API-Schlüssel wurde nicht akzeptiert. Bitte im Zahnrad prüfen.'
  if (status === 402) return 'Kein Guthaben auf dem Konto des Anbieters.'
  if (status === 404) return 'Dieses Modell gibt es für deinen Zugang nicht.'
  if (status === 429) return 'Zu viele Anfragen oder Limit erreicht. Kurz warten und erneut senden.'
  if (status >= 500) return 'Der Anbieter hat gerade eine Störung. Bitte später erneut versuchen.'
  return e?.message || 'Unbekannter Fehler.'
}
