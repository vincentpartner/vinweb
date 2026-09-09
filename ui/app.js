/* VinWeb - Oberfläche.
   Reines JavaScript ohne Framework: Du sollst jede Zeile lesen und aendern koennen. */

const VORSCHAU = 'http://127.0.0.1:4401'

const GERAETE = {
  desktop: [{ name: 'Desktop', w: 1440, h: 900 }],
  tablet:  [{ name: 'Tablet',  w: 834,  h: 1112 }],
  mobile:  [{ name: 'Mobile',  w: 390,  h: 844 }],
  beide:   [{ name: 'Desktop', w: 1440, h: 900 }, { name: 'Mobile', w: 390, h: 844 }]
}

let aktuell = null          // aktuell gewaehltes Projekt
let aktuelleSeite = null    // z. B. "index.html"
let modus = 'beide'

const $ = (s) => document.querySelector(s)
const el = (tag, klasse, text) => {
  const n = document.createElement(tag)
  if (klasse) n.className = klasse
  if (text != null) n.textContent = text
  return n
}
const groesse = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB'
  : b > 1024 ? Math.round(b / 1024) + ' KB' : b + ' B'

// Liest einen Server-Sent-Events-Strom und ruft je Ereignis den Handler auf.
// Wird vom Chat und von der Ernte gemeinsam benutzt.
async function sseLesen (antwort, handler) {
  const leser = antwort.body.getReader()
  const dekoder = new TextDecoder()
  let puffer = ''
  while (true) {
    const { done, value } = await leser.read()
    if (done) break
    puffer += dekoder.decode(value, { stream: true })
    let trenn
    while ((trenn = puffer.indexOf('\n\n')) >= 0) {
      const roh = puffer.slice(0, trenn)
      puffer = puffer.slice(trenn + 2)
      const zeilen = roh.split('\n')
      const art = (zeilen.find(z => z.startsWith('event: ')) || '').slice(7)
      const rohDaten = zeilen.filter(z => z.startsWith('data: ')).map(z => z.slice(6)).join('\n')
      if (art && rohDaten) handler(art, JSON.parse(rohDaten))
    }
  }
}

// Sperrt einen Knopf während einer Aktion, zeigt Drehring + Zwischentext und
// verhindert Doppelklicks. Gibt den Rückgabewert der Aufgabe weiter.
// ---------------------------------------------------------------------------
// Einheitliches Warte- und Fertig-Feedback:
//   banner('läuft…','laeuft')  → grosses Banner oben, bleibt stehen
//   banner('✓ erledigt','ok')  → grün, verschwindet nach ein paar Sekunden
// mitLader() verbindet beides mit dem Knopf (Spinner, gesperrt) – man sieht
// IMMER, dass etwas läuft, und bekommt IMMER ein sichtbares «fertig».
// ---------------------------------------------------------------------------

let bannerTimer = null
function banner (text, art = 'laeuft') {
  let b = document.getElementById('bannerFeedback')
  if (!b) {
    b = el('div')
    b.id = 'bannerFeedback'
    document.body.appendChild(b)
  }
  b.className = 'banner ' + art
  b.textContent = text
  b.hidden = false
  clearTimeout(bannerTimer)
  if (art === 'ok') bannerTimer = setTimeout(() => { b.hidden = true }, 3500)
  if (art === 'fehler') bannerTimer = setTimeout(() => { b.hidden = true }, 8000)
}
function bannerWeg () {
  clearTimeout(bannerTimer)
  const b = document.getElementById('bannerFeedback')
  if (b) b.hidden = true
}

async function mitLader (knopf, textWaehrend, aufgabe, fertigText) {
  if (!knopf || knopf.classList.contains('laedt')) return
  const vorherText = knopf.textContent
  knopf.classList.add('laedt')
  knopf.disabled = true
  if (textWaehrend) {
    knopf.textContent = textWaehrend
    banner(textWaehrend, 'laeuft')
  }
  try {
    const ergebnis = await aufgabe()
    if (fertigText) banner('✓ ' + fertigText, 'ok')
    else bannerWeg()
    return ergebnis
  } catch (e) {
    banner('✗ ' + (e?.message || 'Fehlgeschlagen'), 'fehler')
    throw e
  } finally {
    knopf.classList.remove('laedt')
    knopf.disabled = false
    knopf.textContent = vorherText
  }
}

function status (text, art = '') {
  const s = $('#status')
  s.textContent = text
  s.className = 'status ' + art
}

// ---------------------------------------------------------------------------
// Projekte laden und wechseln
// ---------------------------------------------------------------------------

async function projekteLaden (auswaehlen) {
  const liste = await (await fetch('/api/projekte')).json()
  const wahl = $('#projektwahl')
  wahl.innerHTML = ''
  if (!liste.length) {
    wahl.appendChild(new Option('Noch kein Projekt', ''))
    // Ohne Projekt ist der Import der einzig sinnvolle Startpunkt.
    document.querySelector('.menu [data-reiter="import"]')?.click()
    return
  }
  for (const p of liste) wahl.appendChild(new Option(p.name, p.id))
  const ziel = auswaehlen || (aktuell && aktuell.id) || liste[0].id
  wahl.value = ziel
  await projektOeffnen(ziel)
}

async function projektOeffnen (id) {
  const antwort = await fetch('/api/projekte/' + encodeURIComponent(id))
  if (!antwort.ok) return status('Projekt konnte nicht geladen werden.', 'err')
  const istWechsel = !aktuell || aktuell.id !== id
  aktuell = await antwort.json()
  if (istWechsel) document.querySelector('.menu [data-reiter="start"]')?.click()
  else if (document.querySelector('[data-panel="start"]').classList.contains('aktiv')) fortschrittLaden()
  aktuelleSeite = null
  seitenZeichnen()
  befundeZeichnen()
  strukturZeichnen()
  chatLeeren()
  verlaufLaden()
  textdateienLaden()
  stagingKnoepfeZeigen()
  bausteineZaehlen()
  // Fernlager im Hintergrund abfragen: Hat der Kunde neue Stände hochgeladen?
  fernlagerLaden().then(() => {
    if (fernZustand?.url && fernZustand.tokenDa) fernAbgleichenJetzt(true)
  })
  zeigeBuild = false
  buildVorhanden = false
  $('#btnBuild').hidden = true
  $('#btnQuelle').classList.remove('primary')

  const start = (aktuell.analyse?.seiten || []).find(s => s.rel === 'index.html')
    || (aktuell.analyse?.seiten || [])[0]
  if (start) seiteOeffnen(start.rel)
  else vorschauLeeren()

  const f = (aktuell.analyse?.befunde || []).filter(b => b.stufe === 'fehler').length
  status(`${aktuell.name} geladen - ${aktuell.analyse?.summe.dateien || 0} Dateien`
    + (f ? `, ${f} kritische(r) Punkt(e)` : ''), f ? 'err' : 'ok')
}

// ---------------------------------------------------------------------------
// Seitenliste
// ---------------------------------------------------------------------------

function seitenZeichnen () {
  const box = $('#seitenliste')
  box.innerHTML = ''
  const seiten = aktuell?.analyse?.seiten || []
  $('#seitenzahl').textContent = seiten.length ? `(${seiten.length})` : ''

  // index.html zuerst, danach alphabetisch, Unterordner nach hinten.
  const sortiert = [...seiten].sort((a, b) => {
    if (a.rel === 'index.html') return -1
    if (b.rel === 'index.html') return 1
    const ta = a.rel.includes('/'), tb = b.rel.includes('/')
    if (ta !== tb) return ta ? 1 : -1
    return a.rel.localeCompare(b.rel)
  })

  for (const s of sortiert) {
    const knopf = el('button', 'eintrag')
    knopf.appendChild(el('span', null, s.rel))
    const meta = el('span', 'meta')
    const teile = []
    if (s.lang) teile.push(s.lang)
    teile.push(groesse(s.bytes))
    if (!s.titel) teile.push('kein Titel')
    meta.textContent = teile.join(' · ')
    if (!s.titel) meta.classList.add('warn')
    knopf.appendChild(meta)
    knopf.onclick = () => seiteOeffnen(s.rel)
    knopf.dataset.rel = s.rel

    // Nicht benötigte Seiten lassen sich direkt hier löschen.
    const weg = el('button', 'seite-weg', '×')
    weg.title = 'Seite löschen'
    weg.onclick = async (e) => {
      e.stopPropagation()
      const sicher = confirm(
        `„${s.rel}" wirklich löschen?\n\n` +
        'Der Verlauf behält eine Kopie – über den Reiter Verlauf ist die Seite ' +
        'wiederherstellbar. Verweise anderer Seiten auf diese Seite bleiben ' +
        'bestehen und erscheinen als Befund.')
      if (!sicher) return
      try {
        status('Lösche ' + s.rel + ' …')
        const antwort = await fetch(
          `/api/projekte/${encodeURIComponent(aktuell.id)}/seiten?rel=${encodeURIComponent(s.rel)}`,
          { method: 'DELETE' })
        const daten = await antwort.json()
        if (daten.fehler) return status(daten.fehler, 'err')
        await projektOeffnen(aktuell.id)
        status(s.rel + ' gelöscht – im Verlauf gesichert.', 'ok')
      } catch (fehler) {
        status('Löschen fehlgeschlagen: ' + fehler.message, 'err')
      }
    }
    knopf.appendChild(weg)
    box.appendChild(knopf)
  }
}

// ---------------------------------------------------------------------------
// Vorschau
// ---------------------------------------------------------------------------

function seitenUrl (rel) {
  const pfad = rel.split('/').map(encodeURIComponent).join('/')
  const praefix = zeigeBuild ? '__build__/' : ''
  return `${VORSCHAU}/${encodeURIComponent(aktuell.id)}/${praefix}${pfad}`
}

function seiteOeffnen (rel) {
  aktuelleSeite = rel
  kontextAufSeite(rel)
  for (const k of document.querySelectorAll('#seitenliste .eintrag')) {
    k.classList.toggle('gewaehlt', k.dataset.rel === rel)
  }
  $('#vorschauTitel').textContent = rel
  $('#btnExtern').href = seitenUrl(rel)
  vorschauBauen()
}

function vorschauLeeren () {
  $('#geraete').hidden = true
  $('#vorschauLeer').hidden = false
  $('#geraete').innerHTML = ''
}

function vorschauBauen () {
  if (!aktuell || !aktuelleSeite) return vorschauLeeren()
  const url = seitenUrl(aktuelleSeite)
  const box = $('#geraete')
  box.innerHTML = ''
  box.hidden = false
  $('#vorschauLeer').hidden = true

  for (const g of GERAETE[modus]) {
    const geraet = el('div', 'geraet')
    geraet.dataset.w = g.w
    geraet.dataset.h = g.h

    const rahmenbox = el('div', 'rahmenbox')
    const rahmen = el('div', 'rahmen')
    rahmen.style.width = g.w + 'px'
    rahmen.style.height = g.h + 'px'

    const ifr = document.createElement('iframe')
    // Die Vorschau läuft auf einem anderen Port und ist damit für den Browser
    // eine fremde Herkunft. Zusaetzlich schraenken wir sie hier noch ein.
    ifr.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups')
    ifr.setAttribute('loading', 'eager')
    ifr.src = url
    rahmen.appendChild(ifr)
    rahmenbox.appendChild(rahmen)
    geraet.appendChild(rahmenbox)
    geraet.appendChild(el('div', 'label', `${g.name} · ${g.w} × ${g.h}`))
    box.appendChild(geraet)
  }
  skalieren()
}

// Die Rahmen haben die echte Geraetebreite - sonst wuerden die Umbruchpunkte
// der Website falsch greifen. Verkleinert wird erst danach per Skalierung.
function skalieren () {
  const buehne = $('#buehne')
  const geraete = [...document.querySelectorAll('.geraet')]
  if (!geraete.length) return

  const abstand = 26 * (geraete.length - 1)
  const breiteVerfuegbar = buehne.clientWidth - 48 - abstand
  const hoeheVerfuegbar = buehne.clientHeight - 48 - 30   // Polster + Beschriftung
  const breiteSumme = geraete.reduce((s, g) => s + Number(g.dataset.w), 0)
  const hoeheMax = Math.max(...geraete.map(g => Number(g.dataset.h)))

  let k = Math.min(breiteVerfuegbar / breiteSumme, hoeheVerfuegbar / hoeheMax, 1)
  if (!isFinite(k) || k <= 0) k = 0.5
  k = Math.max(k, 0.15)

  for (const g of geraete) {
    const w = Number(g.dataset.w), h = Number(g.dataset.h)
    const box = g.querySelector('.rahmenbox')
    box.style.width = Math.round(w * k) + 'px'
    box.style.height = Math.round(h * k) + 'px'
    g.querySelector('.rahmen').style.transform = `scale(${k})`
  }
}

// ---------------------------------------------------------------------------
// Befunde
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lösungswege: zu jedem Befund-Code steht hier, WIE man ihn behebt –
// als Erklärung, und wo sinnvoll als fertiger Prompt für den Chat.
// ---------------------------------------------------------------------------

const LOESUNGEN = {
  'zugangsdaten': {
    art: 'automatisch',
    text: 'Nichts zu tun: VinWeb schliesst diese Dateien automatisch von Repo und Build aus. '
      + 'Beim Deploy werden sie separat und geschützt auf den Server gelegt.',
  },
  'zugangsdaten-inhalt': {
    art: 'automatisch',
    text: 'Nichts zu tun: VinWeb hat die Dateien erkannt und hält sie aus Repo und Build heraus. '
      + 'Prüfe nur, ob der Schlüssel wirklich dorthin gehört – sonst Datei löschen.',
  },
  'seo-config': {
    art: 'manuell',
    text: 'Im Reiter SEO über «Aus SiteSett übernehmen» importieren – Titel, Beschreibungen, '
      + 'FAQs und Weiterleitungen kommen dann automatisch in jeden Build.',
  },
  'fremd-ressourcen': {
    art: 'automatisch',
    text: 'Löst der Build: Er lädt alle fremden Quellen herunter, legt sie unter assets/extern/ ab '
      + 'und schreibt die Verweise um. Einfach unter «Build» neu erzeugen.',
  },
  'dateinamen': {
    art: 'automatisch',
    text: 'Löst der Build: Dateinamen werden zu sauberer Kleinschreibung, alle internen Links '
      + 'werden automatisch nachgezogen. Die Quelle bleibt unverändert.',
  },
  'seo-basis': {
    art: 'automatisch',
    text: 'Löst der Build: sitemap.xml, robots.txt und 404.html werden aus deiner SEO-Tabelle '
      + 'erzeugt – Voraussetzung ist eine Domain im Site-Profil (Reiter SEO).',
  },
  'doppelter-baum': {
    art: 'manuell',
    text: 'Der Ordner ist in der Dateizuordnung bereits ausgeschlossen und stört nicht. '
      + 'Endgültig löschen kann ihn Claude Code auf Zuruf – der Build erzeugt seinen eigenen, '
      + 'immer aktuellen Stand.',
  },
  'schwere-medien': {
    art: 'automatisch',
    text: 'Löst der Build: Bilder über 250 KB werden verkleinert und neu komprimiert '
      + '(gleicher Name, kein Verweis bricht). Die Originale in der Quelle bleiben erhalten.',
  },
  'titel-fehlt': {
    art: 'manuell',
    text: 'Im Reiter SEO pflegen – von Hand in der Tabelle, oder mit einem Klick auf '
      + '«KI: fehlende Titel & Beschreibungen» vorschlagen lassen und danach durchlesen.',
  },
  'beschreibung-fehlt': {
    art: 'manuell',
    text: 'Im Reiter SEO pflegen – am schnellsten über «KI: fehlende Titel & Beschreibungen», '
      + 'dann jede Beschreibung kurz gegenlesen (120–160 Zeichen, aktiver Ton).',
  },
  'waisen': {
    art: 'chat',
    text: 'Im Chat verlinken lassen – z. B.: «Verlinke seite-x.html in der Fusszeile '
      + '(assets/footer.js)» oder «Füge auf referenzen.html eine Karte für seite-x.html ein». '
      + 'Nicht mehr gebrauchte Seiten stattdessen über die Seitenliste löschen. Soll eine Seite '
      + 'ABSICHTLICH unverlinkt bleiben (interne Doku, Kampagnen-Landing), füge im Quelltext den '
      + 'Kommentar «vinweb:absichtlich-unverlinkt» ein – dann schweigt dieser Befund.',
  },
  'sprachen': {
    art: 'hinweis',
    text: 'Bewusst zurückgestellt: Erst geht Deutsch live, dann bauen wir die Sprachstufe '
      + '(Ordnerstruktur /en/, Übersetzung Seite für Seite, hreflang) als eigene Etappe.',
  },
  'hreflang-fehlt': {
    art: 'hinweis',
    text: 'Gehört zur Sprachstufe: Sobald mehrere Sprachen echt gepflegt werden, erzeugt VinWeb '
      + 'die hreflang-Verweise automatisch beim Build.',
  },
}

const ART_MARKE = {
  automatisch: ['Löst der Build', 'm-ok'],
  manuell: ['So behebst du es', 'm-hinweis'],
  chat: ['Per Chat beheben', 'm-hinweis'],
  hinweis: ['Einordnung', 'm-hinweis'],
}

// Baut den Lösungsblock unter einem Befund: Erklärung, optional fertiger
// Prompt mit Übernehmen-Knopf, und dazu, was der Prompt bewirkt.
function loesungsBlock (l) {
  const box = el('div', 'loesung')
  const kopf = el('div', 'l-kopf')
  const [label, marke] = ART_MARKE[l.art] || ART_MARKE.hinweis
  kopf.appendChild(el('span', 'marke ' + marke, label))
  box.appendChild(kopf)
  box.appendChild(el('p', 'l-text', l.text))

  if (l.prompt) {
    const pre = el('pre', 'l-prompt', l.prompt)
    box.appendChild(pre)
    const zeile = el('div', 'l-knoepfe')
    const rein = el('button', 'btn klein primary', 'In den Chat übernehmen')
    rein.onclick = (e) => { e.stopPropagation(); promptInChat(l.prompt) }
    const kopieren = el('button', 'btn klein', 'Kopieren')
    kopieren.onclick = async (e) => {
      e.stopPropagation()
      try { await navigator.clipboard.writeText(l.prompt); status('Prompt kopiert.', 'ok') } catch {}
    }
    zeile.appendChild(rein)
    zeile.appendChild(kopieren)
    box.appendChild(zeile)
    if (l.promptErklaerung) box.appendChild(el('p', 'l-warum', 'Was dieser Prompt macht: ' + l.promptErklaerung))
  }
  return box
}

// Legt einen fertigen Prompt ins Chat-Eingabefeld – abgeschickt wird er
// bewusst NICHT automatisch: erst lesen, dann senden.
function promptInChat (text) {
  const feld = $('#prompt')
  feld.value = text
  feld.focus()
  status('Prompt liegt im Chat-Feld – prüfen und mit Senden abschicken.', 'ok')
}

function befundeZeichnen () {
  const box = $('#befundliste')
  box.innerHTML = ''
  const befunde = aktuell?.analyse?.befunde || []
  $('#befundzahl').textContent = befunde.length

  if (!befunde.length) {
    const ok = el('div', 'hinweiskasten')
    ok.innerHTML = '<b>Keine Auffälligkeiten gefunden.</b> Entweder ist der Export schon sehr sauber '
      + '– oder es ist noch kein Projekt geladen.'
    box.appendChild(ok)
    return
  }

  const zusammen = el('div', 'hinweiskasten')
  const anz = (s) => befunde.filter(b => b.stufe === s).length
  zusammen.innerHTML = `<b>${anz('fehler')} kritisch</b>, ${anz('warnung')} zu beheben, `
    + `${anz('hinweis')} zur Kenntnis. Klicke einen Punkt an, um die betroffenen Dateien zu sehen. `
    + 'Behoben wird das in den Etappen 2 und 3 – dieser Bericht sagt dir vorher, was ansteht.'
  box.appendChild(zusammen)

  for (const b of befunde) {
    const karte = el('div', 'befund')
    const kopf = el('div', 'kopf')
    kopf.appendChild(el('span', 'marke m-' + b.stufe,
      b.stufe === 'fehler' ? 'Kritisch' : b.stufe === 'warnung' ? 'Beheben' : 'Hinweis'))
    const t = el('div', 't')
    t.appendChild(el('b', null, b.titel))
    t.appendChild(el('span', null, b.text))
    kopf.appendChild(t)
    if (b.dateien?.length) {
      kopf.appendChild(el('span', 'marke m-ok', b.dateien.length + ' ▾'))
    }
    kopf.onclick = () => karte.classList.toggle('offen')
    karte.appendChild(kopf)

    const loesung = LOESUNGEN[b.code]
    if (b.dateien?.length || loesung) {
      const d = el('div', 'details')
      if (b.dateien?.length) {
        const ul = document.createElement('ul')
        for (const f of b.dateien) ul.appendChild(el('li', null, f))
        d.appendChild(ul)
      }
      if (loesung) d.appendChild(loesungsBlock(loesung))
      karte.appendChild(d)
    }
    box.appendChild(karte)
  }
}

// ---------------------------------------------------------------------------
// Struktur: was gehört ins Repo, was auf den Server
// ---------------------------------------------------------------------------

function strukturZeichnen () {
  const tab = $('#strukturtab')
  tab.innerHTML = ''
  const zeilen = aktuell?.analyse?.struktur || []
  if (!zeilen.length) return

  const gespeichert = aktuell.auswahl || {}

  const kopf = document.createElement('tr')
  for (const [t, k] of [['Eintrag', ''], ['Dateien', 'zahl'], ['Grösse', 'zahl'],
    ['Repo', 'mitte'], ['Server', 'mitte'], ['Begründung', '']]) {
    const th = el('th', k, t)
    kopf.appendChild(th)
  }
  tab.appendChild(kopf)

  for (const z of zeilen) {
    const tr = document.createElement('tr')
    const name = el('td', 'pfad', z.name + (z.istOrdner ? '/' : ''))
    tr.appendChild(name)
    tr.appendChild(el('td', 'zahl', String(z.dateien)))
    tr.appendChild(el('td', 'zahl', groesse(z.bytes)))

    for (const feld of ['repo', 'server']) {
      const td = el('td', 'mitte')
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = gespeichert[z.name]?.[feld] ?? z[feld]
      cb.onchange = () => auswahlSpeichern(z.name, feld, cb.checked)
      td.appendChild(cb)
      tr.appendChild(td)
    }
    tr.appendChild(el('td', 'grund', z.grund))
    tab.appendChild(tr)
  }
}

let speicherTimer = null
function auswahlSpeichern (name, feld, wert) {
  if (!aktuell.auswahl) aktuell.auswahl = {}
  const zeile = aktuell.analyse.struktur.find(s => s.name === name)
  if (!aktuell.auswahl[name]) {
    aktuell.auswahl[name] = { repo: zeile.repo, server: zeile.server }
  }
  aktuell.auswahl[name][feld] = wert

  clearTimeout(speicherTimer)
  speicherTimer = setTimeout(async () => {
    await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/auswahl`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auswahl: aktuell.auswahl })
    })
    status('Auswahl gespeichert.', 'ok')
  }, 400)
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

async function zipHochladen (datei) {
  banner(`«${datei.name}» wird importiert und analysiert …`, 'laeuft')
  status(`Importiere ${datei.name} (${groesse(datei.size)}) …`)
  try {
    const antwort = await fetch('/api/import', {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-dateiname': encodeURIComponent(datei.name)
      },
      body: datei
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler || 'Import fehlgeschlagen.')
    await projekteLaden(daten.id)
    banner(`✓ Import fertig: ${daten.name} ist bereit – Befunde und Vorschau sind geladen.`, 'ok')
  } catch (e) {
    status('Import fehlgeschlagen: ' + e.message, 'err')
    banner('✗ Import fehlgeschlagen: ' + e.message, 'fehler')
  }
}

async function pfadImportieren (pfad) {
  banner('ZIP wird importiert und analysiert …', 'laeuft')
  status('Lese ' + pfad + ' …')
  try {
    const antwort = await fetch('/api/import-pfad', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pfad })
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler || 'Import fehlgeschlagen.')
    $('#pfad').value = ''
    await projekteLaden(daten.id)
    banner(`✓ Import fertig: ${daten.name} ist bereit – Befunde und Vorschau sind geladen.`, 'ok')
  } catch (e) {
    status('Import fehlgeschlagen: ' + e.message, 'err')
    banner('✗ Import fehlgeschlagen: ' + e.message, 'fehler')
  }
}

// ---------------------------------------------------------------------------
// Verdrahtung
// ---------------------------------------------------------------------------

// Schutz vor dem Doppel-Import-Fehler: Ist schon ein Projekt offen, fragt
// der Import nach – meistens ist «Vergleichen» das Richtige, nicht ein
// weiteres Projekt daneben.
function importOderVergleich (datei, pfad) {
  if (!aktuell) { datei ? zipHochladen(datei) : pfadImportieren(pfad); return }

  const overlay = el('div', 'v-overlay')
  const dialog = el('div', 'v-dialog')
  dialog.appendChild(el('div', 'vd-kopf', 'Wohin mit diesem ZIP?'))
  const inhalt = el('div', 'vd-inhalt')
  const hinweis = el('p', 'karten-hinweis')
  hinweis.style.fontSize = '13px'
  hinweis.textContent = `Es ist bereits das Projekt «${aktuell.name}» geöffnet. `
    + 'Ein Design-Update aus Claude Design gehört als VERGLEICH in dieses Projekt – '
    + 'ein zweiter Import würde ein getrenntes Projekt ohne deinen Verlauf anlegen.'
  inhalt.appendChild(hinweis)
  dialog.appendChild(inhalt)

  const fuss = el('div', 'vd-fuss')
  const vgl = el('button', 'btn klein primary', `Mit «${aktuell.name}» vergleichen (empfohlen)`)
  vgl.onclick = () => {
    overlay.remove()
    if (datei) vergleichMitDatei(datei)
    else { $('#vergleichPfad').value = pfad; $('#btnVergleich').click() }
  }
  const neu = el('button', 'btn klein', 'Als NEUES Projekt importieren')
  neu.onclick = () => { overlay.remove(); datei ? zipHochladen(datei) : pfadImportieren(pfad) }
  const abbruch = el('button', 'btn klein', 'Abbrechen')
  abbruch.onclick = () => overlay.remove()
  fuss.appendChild(vgl); fuss.appendChild(neu); fuss.appendChild(abbruch)
  dialog.appendChild(fuss)
  overlay.appendChild(dialog)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

const zone = $('#dropzone')
zone.onclick = () => $('#datei').click()
$('#datei').onchange = (e) => { if (e.target.files[0]) importOderVergleich(e.target.files[0], null) }

for (const ereignis of ['dragenter', 'dragover']) {
  zone.addEventListener(ereignis, (e) => { e.preventDefault(); zone.classList.add('aktiv') })
}
for (const ereignis of ['dragleave', 'drop']) {
  zone.addEventListener(ereignis, () => zone.classList.remove('aktiv'))
}
zone.addEventListener('drop', (e) => {
  e.preventDefault()
  const datei = e.dataTransfer.files[0]
  if (!datei) return
  if (!/\.zip$/i.test(datei.name)) return status('Bitte eine ZIP-Datei ablegen.', 'err')
  importOderVergleich(datei, null)
})
// Verhindert, dass der Browser eine daneben abgelegte Datei einfach oeffnet.
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => e.preventDefault())

$('#btnPfad').onclick = () => {
  const p = $('#pfad').value.trim()
  if (p) importOderVergleich(null, p)
}
$('#pfad').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnPfad').click() })

$('#projektwahl').onchange = (e) => { if (e.target.value) projektOeffnen(e.target.value) }

$('#btnZip').onclick = () => {
  if (!aktuell) return status('Zuerst ein Projekt wählen.', 'err')
  // Der Browser übernimmt den Download – für den Rundgang über SiteSett.
  location.href = `/api/projekte/${encodeURIComponent(aktuell.id)}/zip`
}

$('#btnAnalyse').onclick = () => mitLader($('#btnAnalyse'), 'Analyse läuft …', async () => {
  if (!aktuell) return
  status('Prüfe erneut …')
  const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/analyse`, { method: 'POST' })
  if (!antwort.ok) return status('Prüfung fehlgeschlagen.', 'err')
  await projektOeffnen(aktuell.id)
})

for (const knopf of document.querySelectorAll('.reiter button')) {
  knopf.onclick = () => {
    for (const k of document.querySelectorAll('.reiter button')) k.classList.remove('aktiv')
    knopf.classList.add('aktiv')
    for (const p of document.querySelectorAll('.panel')) {
      p.classList.toggle('aktiv', p.dataset.panel === knopf.dataset.reiter)
    }
    if (knopf.dataset.reiter === 'start') fortschrittLaden()
    if (knopf.dataset.reiter === 'vorschau') skalieren()
    if (knopf.dataset.reiter === 'verlauf') { verlaufLaden(); fernlagerLaden() }
    if (knopf.dataset.reiter === 'build') buildStandLaden()
    if (knopf.dataset.reiter === 'seo') seoLaden()
    if (knopf.dataset.reiter === 'endpruefung') pruefungLaden()
    if (knopf.dataset.reiter === 'bausteine') bausteineLaden()
  }
}

for (const knopf of document.querySelectorAll('[data-geraet]')) {
  knopf.onclick = () => {
    modus = knopf.dataset.geraet
    for (const k of document.querySelectorAll('[data-geraet]')) k.classList.remove('primary')
    knopf.classList.add('primary')
    vorschauBauen()
  }
}

$('#btnNeuladen').onclick = () => vorschauBauen()

let groessenTimer = null
window.addEventListener('resize', () => {
  clearTimeout(groessenTimer)
  groessenTimer = setTimeout(skalieren, 80)
})


/* ===========================================================================
   KI-Chat
   =========================================================================== */

let anhaenge = []                 // aktuell angehängte Dateien
let kontextSeiten = new Set()     // welche Seiten die KI sehen soll
let chatVerlauf = []              // Gesprächsverlauf für die KI
let laeuftGerade = false
let chatAbbruch = null   // AbortController der laufenden Anfrage
const modellPreise = {}  // anbieter -> { modellId: [einUsd, ausUsd] je Mio. Token }

function kostenRechnen (anbieter, modellId, ein, aus) {
  const preis = modellPreise[anbieter]?.[modellId]
  if (!preis) return null
  return (ein || 0) / 1e6 * preis[0] + (aus || 0) / 1e6 * preis[1]
}

function kostenText (v, anbieter, modellId) {
  const teile = []
  if (v.ein != null) teile.push(v.ein.toLocaleString('de-CH') + ' rein')
  teile.push((v.aus || 0).toLocaleString('de-CH') + ' raus' + (v.geschaetzt ? ' (Schätzung)' : ''))
  const usd = kostenRechnen(anbieter, modellId, v.ein, v.aus)
  if (usd != null) teile.push('~$' + (usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)))
  return teile.join(' · ')
}

// ---------------------------------------------------------------------------
// Schlüssel
// ---------------------------------------------------------------------------

async function schluesselStandAnzeigen () {
  const stand = await (await fetch('/api/schluessel')).json()
  $('#schluesselPfad').textContent = stand.datei
  for (const [anbieter, feld] of [['anthropic', '#statusAnthropic'], ['openai', '#statusOpenai'], ['github', '#statusGithub']]) {
    const s = $(feld)
    s.textContent = stand[anbieter].gesetzt ? stand[anbieter].maskiert : 'nicht gesetzt'
    s.classList.toggle('ok', stand[anbieter].gesetzt)
  }
  return stand
}

$('#btnSchluessel').onclick = async () => {
  await schluesselStandAnzeigen()
  $('#keyAnthropic').value = ''
  $('#keyOpenai').value = ''
  $('#keyGithub').value = ''
  $('#kostenLimit').value = localStorage.getItem('vinweb_kostenlimit') || ''
  $('#dlgSchluessel').showModal()
}
$('#kostenLimit').addEventListener('change', (e) => {
  const wert = parseFloat(e.target.value)
  if (wert > 0) localStorage.setItem('vinweb_kostenlimit', String(wert))
  else localStorage.removeItem('vinweb_kostenlimit')
})

$('#btnKeySpeichern').onclick = async () => {
  for (const [anbieter, feld] of [['anthropic', '#keyAnthropic'], ['openai', '#keyOpenai'], ['github', '#keyGithub']]) {
    const wert = $(feld).value.trim()
    if (!wert) continue
    await fetch('/api/schluessel', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anbieter, schluessel: wert }),
    })
  }
  await schluesselStandAnzeigen()
  $('#keyAnthropic').value = ''
  $('#keyOpenai').value = ''
  $('#keyGithub').value = ''
  status('Schlüssel gespeichert.', 'ok')
  await modelleLaden()
  $('#dlgSchluessel').close()
}

// ---------------------------------------------------------------------------
// Modelle
// ---------------------------------------------------------------------------

async function modelleLaden () {
  const anbieter = $('#anbieter').value
  const auswahl = $('#modell')
  auswahl.innerHTML = '<option>lädt …</option>'
  try {
    const liste = await (await fetch('/api/modelle/' + anbieter)).json()
    if (liste.fehler) throw new Error(liste.fehler)
    auswahl.innerHTML = ''
    modellPreise[anbieter] = Object.fromEntries(liste.map(m => [m.id, m.preis]))
    liste.forEach((m, i) => {
      const preis = m.preis ? ` · $${m.preis[0]}/$${m.preis[1]}` : ''
      const monat = m.erschienen
        ? ' · ' + new Date(m.erschienen).toLocaleDateString('de-CH', { month: 'short', year: 'numeric' })
        : ''
      const marke = i === 0 ? '★ ' : ''
      auswahl.appendChild(new Option(marke + m.name + monat + preis, m.id))
    })
    // Gemerkte Wahl gilt – sonst das neuste Modell (steht zuoberst).
    const gemerkt = localStorage.getItem('vinweb_modell_' + anbieter)
    if (gemerkt && liste.some(m => m.id === gemerkt)) auswahl.value = gemerkt
    else if (liste.length) auswahl.value = liste[0].id
  } catch (e) {
    auswahl.innerHTML = ''
    auswahl.appendChild(new Option('Kein Schlüssel – auf ⚙ klicken', ''))
    if (!/Schlüssel/.test(e.message)) status(e.message, 'err')
  }
}

$('#anbieter').onchange = () => {
  localStorage.setItem('vinweb_anbieter', $('#anbieter').value)
  modelleLaden()
}
$('#modell').onchange = () => {
  localStorage.setItem('vinweb_modell_' + $('#anbieter').value, $('#modell').value)
}

// ---------------------------------------------------------------------------
// Kontext – welche Seiten die KI zu sehen bekommt
// ---------------------------------------------------------------------------

let projektTextdateien = []   // alle wählbaren Dateien (Seiten + CSS/JS …)

async function textdateienLaden () {
  if (!aktuell) { projektTextdateien = []; return }
  try {
    projektTextdateien = await (await fetch(
      `/api/projekte/${encodeURIComponent(aktuell.id)}/textdateien`)).json()
    if (projektTextdateien.fehler) projektTextdateien = []
  } catch { projektTextdateien = [] }
  kontextZeichnen()
}

function kontextZeichnen () {
  const box = $('#kontextListe')
  box.innerHTML = ''

  const zeile = (rel) => {
    const label = document.createElement('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = kontextSeiten.has(rel)
    cb.onchange = () => {
      if (cb.checked) kontextSeiten.add(rel); else kontextSeiten.delete(rel)
      kontextTextSetzen()
    }
    label.appendChild(cb)
    label.appendChild(el('span', null, rel))
    return label
  }

  // Aufräum-Knopf: alles abwählen ausser der gerade offenen Seite.
  if (kontextSeiten.size > 1) {
    const leeren = el('button', 'btn klein', 'Auf aktuelle Seite zurücksetzen')
    leeren.style.margin = '6px 0'
    leeren.onclick = () => {
      kontextSeiten = new Set(aktuelleSeite ? [aktuelleSeite] : [])
      kontextZeichnen()
    }
    box.appendChild(leeren)
  }

  const ueberschrift = (text) => {
    const h = el('div', null, text)
    h.style.cssText = 'font-size:9.5px;font-weight:700;letter-spacing:.1em;'
      + 'text-transform:uppercase;color:var(--muted);margin:8px 0 3px'
    return h
  }

  // Erst die Seiten, dann alles Übrige (CSS, JS, PHP …) – damit die KI auch
  // Skripte und Stile zu sehen bekommt, wenn eine Aufgabe sie betrifft.
  const seiten = projektTextdateien.filter(r => /\.html?$/i.test(r) && !r.includes('/'))
  const rest = projektTextdateien.filter(r => !seiten.includes(r))
  if (seiten.length) {
    box.appendChild(ueberschrift('Seiten'))
    for (const r of seiten) box.appendChild(zeile(r))
  }
  if (rest.length) {
    box.appendChild(ueberschrift('Stile, Skripte & Co.'))
    for (const r of rest) box.appendChild(zeile(r))
  }
  kontextTextSetzen()
}

function kontextTextSetzen () {
  const n = kontextSeiten.size
  $('#kontextText').textContent = n === 0
    ? 'Kontext: keine Seite'
    : n === 1
      ? 'Kontext: ' + [...kontextSeiten][0]
      : `Kontext: ${n} Dateien` + (n >= 4 ? ' – gross, macht Anfragen langsam' : '')
}

function kontextAufSeite (rel) {
  // Beim Seitenwechsel nur die SEITE austauschen. Von Hand angehakte Skripte
  // und Stile bleiben stehen – sonst müsste man sie nach jedem Klick neu
  // anhaken, und die KI fragt wieder nach Dateien, die längst gewählt waren.
  const behalten = [...kontextSeiten].filter(r => !/\.html?$/i.test(r))
  kontextSeiten = new Set([rel, ...behalten])
  kontextZeichnen()
}

// ---------------------------------------------------------------------------
// Anhänge
// ---------------------------------------------------------------------------

$('#btnPlus').onclick = () => $('#anhangDatei').click()
$('#anhangDatei').onchange = (e) => {
  for (const datei of e.target.files) anhangAufnehmen(datei)
  e.target.value = ''
}

function anhangAufnehmen (datei) {
  if (datei.size > 12 * 1024 * 1024) {
    return status(`${datei.name} ist zu gross (max. 12 MB).`, 'err')
  }
  const leser = new FileReader()
  leser.onload = () => {
    const base64 = String(leser.result).split(',')[1]
    anhaenge.push({
      name: datei.name,
      mediaType: datei.type || 'application/octet-stream',
      base64,
      istBild: /^image\//.test(datei.type),
    })
    anhaengeZeichnen()
  }
  leser.readAsDataURL(datei)
}

// Ein Anhang als kleines Kärtchen – mit Entfernen-Knopf, wo einer hingehört.
function chipFuer (a, beimEntfernen) {
  const chip = el('span', 'chip')
  if (a.istBild) {
    const bild = document.createElement('img')
    bild.src = `data:${a.mediaType};base64,${a.base64}`
    chip.appendChild(bild)
  }
  chip.appendChild(el('b', null, a.name))
  if (beimEntfernen) {
    const weg = el('button', null, '×')
    weg.title = 'Entfernen'
    weg.onclick = beimEntfernen
    chip.appendChild(weg)
  }
  return chip
}

// Ein Unterschied (Patch) als grün/rot eingefärbte Zeilen.
// Wird für KI-Vorschläge und für den Verlauf gleichermassen benutzt.
function diffElement (patch) {
  const diff = el('div', 'v-diff')
  let begonnen = false
  for (const zeile of patch.split('\n')) {
    if (zeile.startsWith('@@') || zeile.startsWith('diff --git')) begonnen = true
    if (!begonnen) continue
    const z = el('div', null, zeile || ' ')
    if (zeile.startsWith('@@') || zeile.startsWith('diff --git')) z.className = 'kopfz'
    else if (zeile.startsWith('+') && !zeile.startsWith('+++')) z.className = 'zu'
    else if (zeile.startsWith('-') && !zeile.startsWith('---')) z.className = 'weg'
    diff.appendChild(z)
  }
  return diff
}

function anhaengeZeichnen () {
  const box = $('#chatAnhaenge')
  box.innerHTML = ''
  anhaenge.forEach((a, i) => {
    box.appendChild(chipFuer(a, () => { anhaenge.splice(i, 1); anhaengeZeichnen() }))
  })
}

// Bilder lassen sich auch direkt in den Chat ziehen.
const chatSpalte = document.querySelector('.chat')
chatSpalte.addEventListener('dragover', (e) => e.preventDefault())
chatSpalte.addEventListener('drop', (e) => {
  e.preventDefault()
  for (const datei of e.dataTransfer.files) anhangAufnehmen(datei)
})

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

const CHAT_HINWEIS = `<div class="chat-leer">
  Beschreibe hier, was geändert werden soll – zum Beispiel:<br>
  <em>„Erstelle eine neue Referenzseite für Kunde X nach dem Muster von
  Referenz-prodorso.html"</em><br><br>
  Die KI schlägt vor, du gibst frei. Nichts wird ohne dich geschrieben.
</div>`

function chatLeeren () {
  chatVerlauf = []
  anhaenge = []
  anhaengeZeichnen()
  $('#chatVerlauf').innerHTML = CHAT_HINWEIS
}

function blockAnhaengen (art, wer) {
  $('#chatVerlauf').querySelector('.chat-leer')?.remove()
  const b = el('div', 'bl ' + art)
  b.appendChild(el('div', 'wer', wer))
  const txt = el('div', 'txt')
  b.appendChild(txt)
  $('#chatVerlauf').appendChild(b)
  $('#chatVerlauf').scrollTop = $('#chatVerlauf').scrollHeight
  return { block: b, txt }
}

async function senden () {
  if (laeuftGerade) return   // doppeltes Cmd+Enter abfangen
  const frage = $('#prompt').value.trim()
  if (!frage) return
  if (!aktuell) return status('Zuerst ein Projekt laden.', 'err')
  if (!$('#modell').value) return status('Zuerst einen API-Schlüssel hinterlegen (⚙).', 'err')

  const meineAnhaenge = anhaenge.slice()
  const eigen = blockAnhaengen('ich', 'Du')
  eigen.txt.textContent = frage
  if (meineAnhaenge.length) {
    const liste = el('div', 'anhang-liste')
    for (const a of meineAnhaenge) liste.appendChild(chipFuer(a))
    eigen.block.appendChild(liste)
  }

  $('#prompt').value = ''
  anhaenge = []
  anhaengeZeichnen()
  laeuftGerade = true
  chatAbbruch = new AbortController()
  $('#btnSenden').textContent = 'Stopp'
  $('#btnSenden').classList.remove('primary')
  status('Die KI arbeitet … („Stopp" bricht ab, ohne etwas zu schreiben)')

  const antwortBlock = blockAnhaengen('ki', $('#anbieter').value === 'anthropic' ? 'Claude' : 'ChatGPT')
  antwortBlock.txt.classList.add('tippt')
  let gesammelt = ''
  const anbieterJetzt = $('#anbieter').value
  const modellJetzt = $('#modell').value
  const kostenzeile = el('div', 'verbrauch', '…')
  antwortBlock.block.appendChild(kostenzeile)
  const limit = parseFloat(localStorage.getItem('vinweb_kostenlimit') || '') || 0

  // Mitlaufende Anzeige: Uhr + Token + Kosten.
  // Die exakten Zahlen kommen je nach Anbieter erst spät – bis dahin wird die
  // Ausgabe aus der Länge des eingetroffenen Texts geschätzt (~3,5 Zeichen/Token).
  const start = Date.now()
  let exakt = null          // letzte exakte Meldung des Anbieters
  let einBekannt = null
  const anzeige = () => {
    const s = Math.floor((Date.now() - start) / 1000)
    const uhr = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
    const v = exakt || {
      ein: einBekannt,
      aus: Math.round(gesammelt.length / 3.5),
      geschaetzt: true,
    }
    let text = uhr + ' · ' + kostenText(v, anbieterJetzt, modellJetzt)
    if (!gesammelt && !exakt) text = uhr + ' · Modell denkt nach …'
    kostenzeile.textContent = text
    const usd = kostenRechnen(anbieterJetzt, modellJetzt, v.ein, v.aus)
    if (laeuftGerade && limit > 0 && usd != null && usd >= limit) {
      kostenzeile.textContent = text + ' – Kostenlimit erreicht, gestoppt'
      chatAbbruch?.abort()
    }
  }
  const uhrTimer = setInterval(anzeige, 500)

  try {
    const antwort = await fetch('/api/chat', {
      method: 'POST',
      signal: chatAbbruch.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projektId: aktuell.id,
        anbieter: $('#anbieter').value,
        modell: $('#modell').value,
        verlauf: chatVerlauf,
        frage,
        anhaenge: meineAnhaenge,
        kontextSeiten: [...kontextSeiten],
      }),
    })
    if (!antwort.ok || !antwort.body) throw new Error('Verbindung zum Server fehlgeschlagen.')

    let fertigDaten = null
    let fehler = null

    await sseLesen(antwort, (art, daten) => {
      if (art === 'text') {
        gesammelt += daten.t
        // Dateiblöcke nicht im Chat ausbreiten – die kommen als Karte.
        antwortBlock.txt.textContent = gesammelt.split('=== VINWEB-DATEI:')[0]
        $('#chatVerlauf').scrollTop = $('#chatVerlauf').scrollHeight
      } else if (art === 'kontextErweitert') {
        // Automatisch nachgereichte Dateien auch anhaken – so bleiben sie
        // für alle Folgefragen im Kontext.
        for (const rel of daten.dateien || []) kontextSeiten.add(rel)
        kontextZeichnen()
        status('Automatisch nachgereicht: ' + (daten.dateien || []).join(', '), 'ok')
      } else if (art === 'verbrauch') {
        if (daten.ein != null) einBekannt = daten.ein
        if (!daten.geschaetzt) exakt = daten
        anzeige()
      } else if (art === 'fertig') {
        fertigDaten = daten
      } else if (art === 'fehler') {
        fehler = daten.text
      }
    })

    antwortBlock.txt.classList.remove('tippt')

    if (fehler) {
      antwortBlock.block.className = 'bl fehler'
      antwortBlock.txt.textContent = fehler
      status(fehler, 'err')
      return
    }

    if (fertigDaten) {
      antwortBlock.txt.textContent = fertigDaten.text || '(keine Erklärung)'
      chatVerlauf.push({ rolle: 'user', text: frage })
      chatVerlauf.push({ rolle: 'assistant', text: fertigDaten.text })

      if (fertigDaten.verbrauch?.ein != null) {
        const dauer = Math.floor((Date.now() - start) / 1000)
        kostenzeile.textContent = Math.floor(dauer / 60) + ':' + String(dauer % 60).padStart(2, '0')
          + ' · ' + kostenText({ ...fertigDaten.verbrauch, geschaetzt: false }, anbieterJetzt, modellJetzt)
      }
      for (const a of fertigDaten.aenderungen || []) {
        vorschlagZeichnen(antwortBlock.block, a, meineAnhaenge.filter(x => x.istBild))
      }
      const zahl = (fertigDaten.aenderungen || []).filter(a => a.diff).length
      status(zahl ? `${zahl} Änderungsvorschlag/-vorschläge – bitte prüfen und freigeben.` : 'Fertig.', zahl ? '' : 'ok')
    }
  } catch (e) {
    antwortBlock.txt.classList.remove('tippt')
    if (e.name === 'AbortError') {
      antwortBlock.txt.textContent = (gesammelt.split('=== VINWEB-DATEI:')[0] || '')
        + '\n\n[Gestoppt – es wurde nichts geschrieben.]'
      status('Gestoppt.', 'ok')
    } else {
      antwortBlock.block.className = 'bl fehler'
      antwortBlock.txt.textContent = e.message
      status(e.message, 'err')
    }
  } finally {
    clearInterval(uhrTimer)
    laeuftGerade = false
    chatAbbruch = null
    $('#btnSenden').textContent = 'Senden'
    $('#btnSenden').classList.add('primary')
    $('#chatVerlauf').scrollTop = $('#chatVerlauf').scrollHeight
  }
}

$('#btnSenden').onclick = () => {
  if (laeuftGerade) chatAbbruch?.abort()
  else senden()
}
$('#prompt').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); senden() }
})

// ---------------------------------------------------------------------------
// Änderungsvorschlag anzeigen und übernehmen
// ---------------------------------------------------------------------------

function vorschlagZeichnen (elternBlock, a, bilder) {
  const karte = el('div', 'vorschlag')

  if (a.abgelehnt || a.unveraendert) {
    const kopf = el('div', 'v-kopf')
    kopf.appendChild(el('span', 'marke m-hinweis', a.abgelehnt ? 'Abgelehnt' : 'Gleich'))
    kopf.appendChild(el('span', 'v-pfad', a.pfad))
    kopf.appendChild(el('span', 'v-zahlen', a.abgelehnt || 'keine Änderung'))
    karte.appendChild(kopf)
    elternBlock.appendChild(karte)
    return
  }

  const kopf = el('div', 'v-kopf')
  kopf.appendChild(el('span', 'marke ' + (a.neu ? 'm-ok' : 'm-warnung'), a.neu ? 'Neu' : 'Geändert'))
  kopf.appendChild(el('span', 'v-pfad', a.pfad))
  const zahlen = el('span', 'v-zahlen')
  zahlen.appendChild(el('span', 'p', '+' + a.plus))
  zahlen.appendChild(document.createTextNode(' '))
  zahlen.appendChild(el('span', 'm', '−' + a.minus))
  kopf.appendChild(zahlen)
  kopf.onclick = () => karte.classList.toggle('offen')
  karte.appendChild(kopf)

  karte.appendChild(diffElement(a.diff))

  const fuss = el('div', 'v-fuss')
  const ja = el('button', 'btn klein primary', 'Übernehmen')
  const nein = el('button', 'btn klein', 'Verwerfen')
  const ansehen = el('button', 'btn klein', 'Unterschied ansehen')
  ansehen.onclick = () => karte.classList.toggle('offen')

  ja.onclick = async () => {
    ja.disabled = nein.disabled = true
    ja.textContent = 'Schreibe …'
    const dateien = [{ pfad: a.pfad, inhalt: a.inhalt }]
    for (const b of bilder || []) {
      dateien.push({ pfad: 'assets/upload/' + b.name, base64: b.base64 })
    }
    try {
      const antwort = await fetch('/api/anwenden', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projektId: aktuell.id, dateien, notiz: 'KI-Änderung: ' + a.pfad }),
      })
      const daten = await antwort.json()
      if (!antwort.ok) throw new Error(daten.fehler)
      karte.classList.add('erledigt')
      fuss.innerHTML = ''
      fuss.appendChild(el('span', 'marke m-ok', 'Übernommen'))
      fuss.appendChild(el('span', 'v-zahlen', 'Sicherung: ' + daten.sicherung))
      await nachAenderung(daten.projekt,
        daten.stand
          ? 'Übernommen und als Stand ' + daten.stand + ' gesichert.'
          : 'Übernommen. Alter Stand liegt in versionen/' + daten.sicherung)
    } catch (e) {
      ja.disabled = nein.disabled = false
      ja.textContent = 'Übernehmen'
      status('Konnte nicht schreiben: ' + e.message, 'err')
    }
  }

  nein.onclick = () => {
    karte.classList.add('erledigt')
    fuss.innerHTML = ''
    fuss.appendChild(el('span', 'marke m-hinweis', 'Verworfen'))
  }

  fuss.appendChild(ja)
  fuss.appendChild(nein)
  fuss.appendChild(ansehen)
  karte.appendChild(fuss)
  elternBlock.appendChild(karte)
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

$('#anbieter').value = localStorage.getItem('vinweb_anbieter') || 'anthropic'
modelleLaden()

// Projekte erst laden, wenn alles oben definiert ist.
projekteLaden().catch(e => status('Start fehlgeschlagen: ' + e.message, 'err'))

/* ===========================================================================
   Verlauf – Stände sichern, ansehen, zurückholen
   =========================================================================== */

let staende = []
let tagFilter = ''

function tagName (datum) {
  const d = new Date(datum)
  const heute = new Date()
  const gestern = new Date(Date.now() - 86400000)
  const gleich = (a, b) => a.toDateString() === b.toDateString()
  if (gleich(d, heute)) return 'Heute, ' + d.toLocaleDateString('de-CH', { day: 'numeric', month: 'long' })
  if (gleich(d, gestern)) return 'Gestern, ' + d.toLocaleDateString('de-CH', { day: 'numeric', month: 'long' })
  return d.toLocaleDateString('de-CH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
}

let autoSekunden = null
async function infoLaden () {
  if (autoSekunden !== null) return
  try {
    const info = await (await fetch('/api/info')).json()
    autoSekunden = info.autoSichernSekunden || 0
    const takt = document.querySelector('#autoTakt')
    if (takt) {
      takt.textContent = autoSekunden > 0
        ? `Automatische Sicherung: alle ${Math.round(autoSekunden / 60)} Min.`
        : 'Automatische Sicherung: aus'
    }
  } catch { /* nicht schlimm */ }
}

async function verlaufLaden () {
  if (!aktuell) return
  infoLaden()
  try {
    staende = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/verlauf`)).json()
    if (staende.fehler) throw new Error(staende.fehler)
  } catch {
    staende = []
  }
  $('#verlaufzahl').textContent = staende.length
  $('#ungesichertStreifen').hidden = !aktuell.ungesichert
  verlaufZeichnen()
}

function verlaufZeichnen () {
  const box = $('#verlaufListe')
  box.innerHTML = ''

  const gefiltert = tagFilter
    ? staende.filter(s => new Date(s.datum).toISOString().slice(0, 10) === tagFilter)
    : staende

  if (!gefiltert.length) {
    box.appendChild(el('div', 'verlauf-leer', staende.length
      ? 'An diesem Tag wurde nichts gesichert.'
      : 'Noch keine Stände. Der erste entsteht beim Import oder beim ersten Sichern.'))
    return
  }

  let letzterTag = null
  gefiltert.forEach((s, i) => {
    const tag = tagName(s.datum)
    if (tag !== letzterTag) {
      box.appendChild(el('div', 'tag', tag))
      letzterTag = tag
    }
    box.appendChild(standZeichnen(s, staende.indexOf(s) === 0))
  })
}

function standZeichnen (s, istAktuell) {
  const karte = el('div', 'stand' + (istAktuell ? ' jetzt' : ''))

  const kopf = el('div', 's-kopf')
  kopf.appendChild(el('span', 's-zeit',
    new Date(s.datum).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })))
  kopf.appendChild(el('span', 's-text', s.nachricht))
  kopf.appendChild(el('span', 's-zahl',
    s.dateien.length === 1 ? '1 Datei' : s.dateien.length + ' Dateien'))

  if (istAktuell) {
    kopf.appendChild(el('span', 'marke m-ok', 'Aktueller Stand'))
  } else {
    const ansehen = el('button', 'btn klein', 'Ansehen')
    ansehen.onclick = () => standAnsehen(karte, s, ansehen)
    kopf.appendChild(ansehen)

    const zurueck = el('button', 'btn klein primary', 'Zurück zu diesem Stand')
    zurueck.onclick = () => mitLader(zurueck, 'Setze zurück …', () => standZurueck(s))
    kopf.appendChild(zurueck)
  }
  karte.appendChild(kopf)

  const details = el('div', 's-details')
  details.appendChild(el('div', 's-hinweis', 'Wird geladen …'))
  karte.appendChild(details)
  return karte
}

async function standAnsehen (karte, s, knopf) {
  if (karte.classList.contains('offen')) { karte.classList.remove('offen'); return }
  karte.classList.add('offen')
  const details = karte.querySelector('.s-details')
  if (karte.dataset.geladen) return

  knopf.textContent = 'lädt …'
  try {
    const v = await (await fetch(
      `/api/projekte/${encodeURIComponent(aktuell.id)}/verlauf/${s.hash}/vergleich`)).json()
    if (v.fehler) throw new Error(v.fehler)

    details.innerHTML = ''
    details.appendChild(el('div', 's-hinweis',
      v.stat ? 'Beim Zurückgehen auf diesen Stand würde sich das ändern:'
             : 'Dieser Stand ist mit dem aktuellen identisch – es gäbe nichts zu ändern.'))

    if (s.dateien.length) {
      const liste = el('div', 's-dateien')
      for (const datei of s.dateien) {
        const zeile = el('div', 's-datei')
        zeile.appendChild(el('span', null, datei))
        const nur = el('button', 'btn klein', 'nur diese Datei zurück')
        nur.onclick = () => mitLader(nur, '…', () => dateiZurueck(s, datei))
        zeile.appendChild(nur)
        liste.appendChild(zeile)
      }
      details.appendChild(liste)
    }

    if (v.patch?.trim()) {
      const diff = diffElement(v.patch)
      diff.style.display = 'block'
      details.appendChild(diff)
    }
    karte.dataset.geladen = '1'
  } catch (e) {
    details.innerHTML = ''
    details.appendChild(el('div', 's-hinweis', 'Konnte nicht geladen werden: ' + e.message))
  } finally {
    knopf.textContent = 'Ansehen'
  }
}

async function standZurueck (s) {
  const wann = new Date(s.datum).toLocaleString('de-CH')
  const ok = confirm(
    `Das ganze Projekt auf den Stand vom ${wann} zurücksetzen?\n\n`
    + `„${s.nachricht}"\n\n`
    + 'Der aktuelle Stand wird vorher gesichert – es geht nichts verloren, '
    + 'und du kannst jederzeit wieder vorwärts.')
  if (!ok) return

  status('Setze zurück …')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/zurueck`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: s.hash }),
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler)
    await nachAenderung(daten.projekt, `Zurückgesetzt auf den Stand vom ${wann}.`)
  } catch (e) {
    status('Zurücksetzen fehlgeschlagen: ' + e.message, 'err')
  }
}

async function dateiZurueck (s, datei) {
  const wann = new Date(s.datum).toLocaleString('de-CH')
  if (!confirm(`Nur „${datei}" auf den Stand vom ${wann} zurücksetzen?\n\n`
    + 'Alle anderen Dateien bleiben, wie sie sind.')) return

  status('Setze Datei zurück …')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/zurueck-datei`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: s.hash, datei }),
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler)
    await nachAenderung(daten.projekt, `${datei} zurückgesetzt.`)
  } catch (e) {
    status('Zurücksetzen fehlgeschlagen: ' + e.message, 'err')
  }
}

// Nach jedem Eingriff: Oberfläche auffrischen.
async function nachAenderung (projekt, meldung) {
  aktuell = projekt
  seitenZeichnen()
  befundeZeichnen()
  strukturZeichnen()
  kontextZeichnen()
  if (aktuelleSeite) seiteOeffnen(aktuelleSeite)
  await verlaufLaden()
  status(meldung, 'ok')
}

async function jetztSichern (name) {
  status('Sichere …')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/sichern`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nachricht: name }),
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler)
    aktuell.ungesichert = false
    $('#standName').value = ''
    await verlaufLaden()
    status(daten.nichtsZuTun ? 'Nichts geändert – kein neuer Stand nötig.' : 'Stand gesichert.', 'ok')
  } catch (e) {
    status('Sichern fehlgeschlagen: ' + e.message, 'err')
  }
}

$('#btnSichern').onclick = () => {
  if (!aktuell) return status('Zuerst ein Projekt laden.', 'err')
  jetztSichern($('#standName').value.trim() || 'Stand gesichert')
}
$('#btnJetztSichern').onclick = () => mitLader($('#btnJetztSichern'), 'Sichere …', () => jetztSichern('Änderungen von aussen'), 'Gesichert – im Verlauf abgelegt.')
$('#standName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnSichern').click() })
$('#standDatum').onchange = (e) => { tagFilter = e.target.value; verlaufZeichnen() }
$('#btnDatumWeg').onclick = () => { tagFilter = ''; $('#standDatum').value = ''; verlaufZeichnen() }

/* ===========================================================================
   Build – Produktions-Build erstellen und ansehen
   =========================================================================== */

let buildVorhanden = false
let zeigeBuild = false

function mb (b) { return (b / 1048576).toFixed(1) + ' MB' }

async function buildStandLaden () {
  if (!aktuell) return
  let bericht = null
  try {
    bericht = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/build`)).json()
  } catch { /* keiner da */ }
  buildVorhanden = !!bericht
  $('#btnBuild').hidden = !buildVorhanden
  $('#btnBuildAnsehen').hidden = !buildVorhanden
  if (bericht) buildBerichtZeichnen(bericht)
  else $('#buildStatus').textContent = 'Noch kein Build erstellt.'
}

function kachel(zahl, text, art = '') {
  const k = el('div', 'kachel ' + art)
  k.appendChild(el('div', 'gross', zahl))
  k.appendChild(el('div', 'klein', text))
  return k
}

function buildGruppe(titel, anzahl, zeilenBauer, eintraege) {
  if (!eintraege.length) return null
  const g = el('div', 'build-gruppe')
  const h = el('h4')
  h.appendChild(document.createTextNode(titel))
  h.appendChild(el('span', 'z', String(anzahl)))
  g.appendChild(h)
  const liste = el('div', 'build-liste')
  for (const e of eintraege) liste.appendChild(zeilenBauer(e))
  g.appendChild(liste)
  return g
}

function buildBerichtZeichnen (b) {
  const wann = new Date(b.erstelltAm).toLocaleString('de-CH')
  $('#buildStatus').textContent = 'Build vom ' + wann
  const box = $('#buildBericht')
  box.innerHTML = ''

  // Kacheln
  const reihe = el('div', 'kachel-reihe')
  reihe.appendChild(kachel(b.dateien, 'Dateien im Build'))
  reihe.appendChild(kachel(b.downloads.length, 'Bilder lokalisiert', b.downloads.length ? 'gut' : ''))
  reihe.appendChild(kachel(mb(b.gespartBytes), 'gespart', b.gespartBytes ? 'gut' : ''))
  reihe.appendChild(kachel(b.umbenannt.length, 'Dateien umbenannt'))
  if (b.downloadFehler.length) reihe.appendChild(kachel(b.downloadFehler.length, 'Download-Fehler', 'warn'))
  box.appendChild(reihe)

  if (b.hinweise.length) {
    // Review-Fund 1: Hinweise stammen teils aus Projektdaten (Sidecar-Schlüssel,
    // Dateinamen) – dürfen NIE als HTML interpretiert werden.
    const h = el('div', 'hinweiskasten')
    h.appendChild(el('b', null, 'Zur Kenntnis:'))
    for (const x of b.hinweise) {
      h.appendChild(document.createElement('br'))
      h.appendChild(document.createTextNode('• ' + x))
    }
    box.appendChild(h)
  }

  const gruppen = [
    buildGruppe('Fremde Bilder heruntergeladen', b.downloads.length, (d) => {
      const z = el('div', 'build-zeile')
      z.appendChild(el('span', 'pf', d.datei))
      z.appendChild(el('span', 'von', Math.round(d.bytes / 1024) + ' KB'))
      return z
    }, b.downloads),

    b.downloadFehler.length ? buildGruppe('Download fehlgeschlagen', b.downloadFehler.length, (d) => {
      const z = el('div', 'build-zeile')
      z.appendChild(el('span', 'pf', d.url))
      z.appendChild(el('span', 'von', d.fehler))
      return z
    }, b.downloadFehler) : null,

    buildGruppe('Bilder verkleinert', b.verkleinert.length, (v) => {
      const z = el('div', 'build-zeile')
      z.appendChild(el('span', 'pf', v.rel))
      z.appendChild(el('span', 'von', Math.round(v.vorher / 1024) + ' KB'))
      z.appendChild(el('span', 'pfeil', '→'))
      z.appendChild(el('span', 'nach', Math.round(v.nachher / 1024) + ' KB'))
      return z
    }, b.verkleinert),

    buildGruppe('Dateinamen auf Kleinschreibung', b.umbenannt.length, (u) => {
      const z = el('div', 'build-zeile')
      z.appendChild(el('span', 'von', u.alt))
      z.appendChild(el('span', 'pfeil', '→'))
      z.appendChild(el('span', 'nach', u.neu))
      return z
    }, b.umbenannt),

    buildGruppe('Nicht in den Build übernommen', b.uebersprungen.length, (u) => {
      const z = el('div', 'build-zeile')
      z.appendChild(el('span', 'pf', u.rel))
      z.appendChild(el('span', 'von', u.grund))
      return z
    }, b.uebersprungen),
  ]
  for (const g of gruppen) if (g) box.appendChild(g)
}

async function buildErstellen () {
  if (!aktuell) return status('Zuerst ein Projekt laden.', 'err')
  $('#btnBuildErzeugen').disabled = true
  $('#btnBuildErzeugen').textContent = 'Baue … (kann etwas dauern)'
  status('Erstelle Produktions-Build – lädt Bilder und optimiert …')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/build`, { method: 'POST' })
    const bericht = await antwort.json()
    if (!antwort.ok) throw new Error(bericht.fehler)
    buildVorhanden = true
    $('#btnBuild').hidden = false
    $('#btnBuildAnsehen').hidden = false
    buildBerichtZeichnen(bericht)
    const g = bericht.downloadFehler.length
    status(g ? `Build fertig, aber ${g} Download(s) fehlgeschlagen.` : 'Build fertig.', g ? 'err' : 'ok')
  } catch (e) {
    status('Build fehlgeschlagen: ' + e.message, 'err')
  } finally {
    $('#btnBuildErzeugen').disabled = false
    $('#btnBuildErzeugen').textContent = 'Produktions-Build neu erstellen'
  }
}

// Vorschau zwischen Quelle und Build umschalten.
function quelleOderBuild (build) {
  zeigeBuild = build
  $('#btnQuelle').classList.toggle('primary', !build)
  $('#btnBuild').classList.toggle('primary', build)
  // Beim Build ist die Startseite immer index.html (kleingeschrieben).
  if (build) aktuelleSeite = 'index.html'
  vorschauBauen()
}

$('#btnBuildErzeugen').onclick = () => mitLader($('#btnBuildErzeugen'), 'Build läuft – bitte warten …', buildErstellen, 'Build fertig. Du kannst weitermachen.')
$('#btnBuildAnsehen').onclick = () => {
  document.querySelector('.reiter button[data-reiter="vorschau"]').click()
  quelleOderBuild(true)
}
$('#btnQuelle').onclick = () => quelleOderBuild(false)
$('#btnBuild').onclick = () => quelleOderBuild(true)

/* ===========================================================================
   Inhalte ernten – Texte und Bilder einer bestehenden Website
   =========================================================================== */

let ernteAbbruch = null

async function ernteStarten () {
  const url = $('#ernteUrl').value.trim()
  if (!url) return status('Bitte eine Adresse eingeben, z. B. www.kunde.ch', 'err')
  ernteAbbruch = new AbortController()
  $('#btnErnteStopp').hidden = false

  $('#btnErnte').disabled = true
  const stand = $('#ernteStand')
  stand.textContent = 'Starte …'

  try {
    const antwort = await fetch('/api/ernte', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, nurSeite: $('#ernteNurSeite').checked }),
      signal: ernteAbbruch.signal,
    })
    if (!antwort.ok || !antwort.body) throw new Error('Verbindung fehlgeschlagen.')

    let bericht = null
    let fehler = null

    await sseLesen(antwort, (art, d) => {
      if (art === 'meldung') stand.textContent = d.text
      else if (art === 'fertig') bericht = d
      else if (art === 'fehler') fehler = d.text
    })

    if (fehler) throw new Error(fehler)
    if (bericht) {
      stand.innerHTML = ''
      stand.appendChild(el('span', null,
        `Fertig: ${bericht.seiten} Seiten, ${bericht.bilder} Bilder `
        + `(${(bericht.bilderBytes / 1048576).toFixed(1)} MB)`
        + (bericht.fehler.length ? ` – ${bericht.fehler.length} übersprungen` : '') + ' '))
      const oeffnen = el('button', 'btn klein', 'Ordner öffnen')
      oeffnen.style.marginTop = '6px'
      oeffnen.onclick = () => fetch('/api/ernte/oeffnen', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ordner: bericht.ordner }),
      })
      stand.appendChild(document.createElement('br'))
      stand.appendChild(oeffnen)
      status(bericht.gestoppt ? 'Ernte gestoppt – Teilstand gespeichert.' : 'Ernte abgeschlossen.', 'ok')
    }
  } catch (e) {
    if (e.name === 'AbortError') {
      stand.textContent = 'Gestoppt. Das bisher Gesammelte liegt im Ernte-Ordner (siehe Liste unten).'
      status('Ernte gestoppt.', 'ok')
    } else {
      stand.textContent = 'Fehlgeschlagen: ' + e.message
      status('Ernte fehlgeschlagen: ' + e.message, 'err')
    }
  } finally {
    $('#btnErnteStopp').hidden = true
    ernteAbbruch = null
    ernteListeLaden()
    $('#btnErnte').disabled = false
  }
}

$('#btnErnte').onclick = ernteStarten
$('#btnErnteStopp').onclick = () => { ernteAbbruch?.abort(); $('#btnErnteStopp').hidden = true }

// ---------------------------------------------------------------------------
// Ernte-Verwaltung: Liste mit Datum, Adresse, Öffnen und Löschen
// ---------------------------------------------------------------------------

async function ernteListeLaden () {
  const box = $('#ernteListe')
  let liste = []
  try { liste = await (await fetch('/api/ernten')).json() } catch { return }
  box.innerHTML = ''
  if (!Array.isArray(liste) || !liste.length) return
  box.appendChild(el('div', 'pal-title', 'Bisherige Ernten'))
  for (const e of liste) {
    const zeile = el('div', 'ernte-zeile')
    const wann = e.erstelltAm
      ? new Date(e.erstelltAm).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })
      : '–'
    zeile.appendChild(el('span', 'wann', wann))
    zeile.appendChild(el('span', 'wo', e.url + (e.nurSeite ? ' (eine Seite)' : '') + (e.gestoppt ? ' · gestoppt' : '')))
    if (e.seiten != null) zeile.appendChild(el('span', 'zahlen', `${e.seiten} S. · ${e.bilder} B.`))
    const oeffnen = el('button', 'btn klein', 'Öffnen')
    oeffnen.onclick = () => fetch('/api/ernte/oeffnen', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ordner: e.ordner }),
    })
    const weg = el('button', 'btn klein', '✕')
    weg.title = 'Diese Ernte endgültig löschen'
    weg.onclick = async () => {
      if (!confirm(`Ernte vom ${wann} (${e.url}) endgültig löschen?`)) return
      await mitLader(weg, '…', async () => {
        const r = await fetch('/api/ernten/' + encodeURIComponent(e.name), { method: 'DELETE' })
        if (r.ok) { status('Ernte gelöscht.', 'ok'); ernteListeLaden() }
        else status('Löschen fehlgeschlagen.', 'err')
      })
    }
    zeile.appendChild(oeffnen)
    zeile.appendChild(weg)
    box.appendChild(zeile)
  }
}
ernteListeLaden()
$('#ernteUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') ernteStarten() })

/* ===========================================================================
   SEO – Site-Profil, Seiten-Metadaten, Weiterleitungen
   =========================================================================== */

let seoDaten = null
let seoTimer = null

function seoSpeichern (sofort = false) {
  clearTimeout(seoTimer)
  const tun = async () => {
    if (!aktuell || !seoDaten) return
    await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/seo`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seo: seoDaten }),
    })
    $('#seoStatus').textContent = 'Gespeichert.'
  }
  if (sofort) return tun()
  seoTimer = setTimeout(tun, 500)
}

async function seoLaden () {
  if (!aktuell) return
  seoDaten = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/seo`)).json()
  seoZeichnen()
}

// Zeichenzähler mit Bewertung – hilft, die Richtwerte zu treffen.
function zaehler (input, min, max) {
  const z = el('span', 'zeichen')
  const setzen = () => {
    const n = input.value.length
    z.textContent = n + ' Z.'
    z.className = 'zeichen ' + (n === 0 ? '' : n >= min && n <= max ? 'gut' : 'schlecht')
  }
  input.addEventListener('input', setzen)
  setzen()
  return z
}

function seoZeichnen () {
  if (!seoDaten) return

  // --- Site-Profil ---
  const profil = $('#seoProfil')
  profil.innerHTML = ''
  const felder = [
    ['domain', 'Domain (mit https://)'], ['name', 'Name der Website'],
    ['beschreibung', 'Kurzbeschreibung'], ['email', 'E-Mail'],
    ['telefon', 'Telefon'], ['strasse', 'Strasse'],
    ['plz', 'PLZ'], ['ort', 'Ort'], ['ogBild', 'Standard-Vorschaubild (URL)'],
  ]
  for (const [feld, beschriftung] of felder) {
    const box = el('div')
    const lab = el('label', null, beschriftung)
    const input = document.createElement('input')
    input.type = 'text'
    input.value = seoDaten.site[feld] || ''
    input.oninput = () => { seoDaten.site[feld] = input.value.trim(); seoSpeichern() }
    box.appendChild(lab)
    box.appendChild(input)
    profil.appendChild(box)
  }

  // --- Seiten ---
  const seiten = $('#seoSeiten')
  seiten.innerHTML = ''
  const eintraege = Object.entries(seoDaten.pages).sort((a, b) => a[0].localeCompare(b[0]))
  $('#seoSeitenZahl').textContent = eintraege.length

  for (const [datei, p] of eintraege) {
    const karte = el('div', 'seo-seite')

    const kopf = el('div', 'kopf')
    kopf.appendChild(el('span', 'datei', datei))
    const cbLabel = el('label')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = p.indexierbar !== false
    cb.onchange = () => { p.indexierbar = cb.checked; seoSpeichern() }
    cbLabel.appendChild(cb)
    cbLabel.appendChild(document.createTextNode('bei Google auffindbar'))
    kopf.appendChild(cbLabel)
    karte.appendChild(kopf)

    const titel = document.createElement('input')
    titel.type = 'text'
    titel.placeholder = 'Titel (blaue Zeile in der Google-Trefferliste)'
    titel.value = p.titel || ''
    titel.oninput = () => { p.titel = titel.value; seoSpeichern() }
    const tZeile = el('div')
    tZeile.appendChild(titel)
    karte.appendChild(tZeile)
    kopf.appendChild(zaehler(titel, 50, 60))

    const beschr = document.createElement('input')
    beschr.type = 'text'
    beschr.placeholder = 'Beschreibung (grauer Text darunter)'
    beschr.value = p.beschreibung || ''
    beschr.oninput = () => { p.beschreibung = beschr.value; seoSpeichern() }
    const bZeile = el('div')
    bZeile.appendChild(beschr)
    karte.appendChild(bZeile)
    kopf.appendChild(zaehler(beschr, 120, 160))

    seiten.appendChild(karte)
  }

  // --- Weiterleitungen ---
  $('#seoRedirZahl').textContent = seoDaten.redirects.length
  const ta = $('#seoRedirects')
  ta.value = seoDaten.redirects.map(r => r.von + ' ' + r.nach).join('\n')
  ta.onchange = () => {
    seoDaten.redirects = ta.value.split('\n')
      .map(z => z.trim().split(/\s+/))
      .filter(t => t.length >= 2 && t[0].startsWith('/'))
      .map(([von, nach]) => ({ von, nach }))
    $('#seoRedirZahl').textContent = seoDaten.redirects.length
    seoSpeichern()
  }
}

$('#btnSitesett').onclick = async () => {
  if (!aktuell) return
  const vorschlag = '~/Downloads/Apps/Webdesign/SEO/sitesett-config.json'
  const pfad = prompt('Pfad zur sitesett-config.json:', vorschlag)
  if (!pfad) return
  $('#seoStatus').textContent = 'Übernehme …'
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/seo/import-sitesett`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pfad }),
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler)
    seoDaten = daten.seo
    seoZeichnen()
    const u = daten.uebernommen
    const teile = [`Übernommen: ${u.seiten} Seiten, ${u.redirects} Weiterleitungen`]
    if (u.bilder) teile.push(`${u.bilder} Bild(er) ins Projekt gelegt`)
    if (u.geschuetzteSeiten || u.geschuetzteFelder) {
      teile.push(`Handarbeit geschützt: ${u.geschuetzteSeiten} Seite(n), ${u.geschuetzteFelder} Feld(er) blieben erhalten`)
    }
    if (u.schluesselVerworfen) teile.push('API-Schlüssel aus der Datei verworfen')
    $('#seoStatus').textContent = teile.join(' · ')
  } catch (e) {
    $('#seoStatus').textContent = 'Fehlgeschlagen: ' + e.message
  }
}

$('#btnKiFuellen').onclick = () => mitLader($('#btnKiFuellen'), 'KI schreibt …', async () => {
  if (!aktuell) return
  if (!$('#modell').value) return status('Zuerst einen API-Schlüssel hinterlegen (⚙).', 'err')
  $('#btnKiFuellen').disabled = true
  $('#seoStatus').textContent = 'Die KI schreibt Vorschläge … (je Seite ein Aufruf, das dauert etwas)'
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/seo/ki-fuellen`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anbieter: $('#anbieter').value, modell: $('#modell').value }),
    })
    const daten = await antwort.json()
    if (!antwort.ok) throw new Error(daten.fehler)
    seoDaten = daten.seo
    seoZeichnen()
    $('#seoStatus').textContent = daten.gefuellt
      ? `${daten.gefuellt} Feld(er) vorgeschlagen – bitte durchsehen, geschrieben wird erst beim Build.`
      : 'Nichts zu füllen – alle Seiten haben Titel und Beschreibung.'
  } catch (e) {
    $('#seoStatus').textContent = 'Fehlgeschlagen: ' + e.message
  } finally {
    $('#btnKiFuellen').disabled = false
  }
})


// ---------------------------------------------------------------------------
// Startseite: der Weg zum Go-Live
// ---------------------------------------------------------------------------

async function fortschrittLaden () {
  if (!aktuell) return
  try {
    const f = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/fortschritt`)).json()
    if (!f.fehler) startZeichnen(f)
  } catch { /* Startseite bleibt dann einfach leer */ }
}

function startZeichnen (f) {
  const box = $('#startInhalt')
  box.innerHTML = ''

  // Kopf: Projektname gross, Fortschritt als grosse Zahl
  const kopf = el('div', 'start-kopf')
  const links = el('div')
  const h1 = el('h1', null, aktuell.name)
  const unter = el('div', 'unter', 'Der Weg zum Go-Live – Schritt für Schritt, bis alles grün ist.')
  links.appendChild(h1); links.appendChild(unter)
  const zahl = el('div', 'start-zahl')
  zahl.appendChild(el('b', null, `${f.fertigZahl} / ${f.gesamt}`))
  zahl.appendChild(el('span', null, 'Schritte fertig'))
  kopf.appendChild(links); kopf.appendChild(zahl)
  box.appendChild(kopf)

  // Statuskarte: dunkel = unterwegs, grün = Ready to Live
  const karte = el('div', 'ready-karte ' + (f.bereit ? 'gruen' : 'dunkel'))
  const kt = el('div')
  if (f.live) {
    kt.appendChild(el('b', null, 'Live!'))
    kt.appendChild(el('span', null, 'Dieses Projekt ist veröffentlicht.'))
  } else if (f.bereit) {
    kt.appendChild(el('b', null, 'Ready to Live'))
    kt.appendChild(el('span', null, 'Alle Vorstufen sind grün – dem Livegang steht nichts mehr im Weg.'))
  } else {
    const offen = f.schritte.filter(s => !s.fertig && s.id !== 'golive').length
    kt.appendChild(el('b', null, `Noch ${offen} Schritt${offen === 1 ? '' : 'e'} bis zum Go-Live`))
    const naechster = f.schritte.find(s => !s.fertig && s.id !== 'golive')
    kt.appendChild(el('span', null, naechster ? `Als Nächstes: ${naechster.titel}` : ''))
  }
  karte.appendChild(kt)
  const golive = el('button', 'btn primary', f.live ? 'Ist live' : 'Livegang')
  golive.disabled = true
  golive.title = 'Kommt mit dem Deploy (Etappe 6) – dann startet hier der Livegang.'
  karte.appendChild(golive)
  box.appendChild(karte)

  // Die acht Schritte
  const liste = el('div')
  for (const s of f.schritte) {
    const zeile = el('div', 'schritt' + (s.fertig ? ' fertig' : ''))
    zeile.appendChild(el('span', 'nr', String(s.nr).padStart(2, '0')))

    const st = el('div', 'st')
    st.appendChild(el('b', null, s.titel))
    st.appendChild(el('span', null, s.detail || s.text))
    zeile.appendChild(st)

    if (s.art === 'manuell') {
      const tun = el('button', 'btn klein' + (s.fertig ? '' : ' primary'),
        s.fertig ? 'Haken zurücknehmen' : 'Als fertig markieren')
      tun.className += ' tun'
      tun.onclick = async (e) => {
        e.stopPropagation()
        tun.disabled = true
        try {
          const neu = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/fortschritt`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ schritt: s.id, fertig: !s.fertig }),
          })).json()
          if (neu.fehler) status(neu.fehler, 'err')
          else startZeichnen(neu)
        } catch { status('Speichern fehlgeschlagen.', 'err') }
      }
      zeile.appendChild(tun)
    }

    const haken = el('span', 'haken', '✓')
    zeile.appendChild(haken)

    // Klick auf die Zeile führt zum passenden Arbeitsbereich.
    zeile.onclick = () => {
      if (s.ziel && s.ziel !== 'start') {
        document.querySelector(`.menu [data-reiter="${s.ziel}"]`)?.click()
      }
    }
    liste.appendChild(zeile)
  }
  box.appendChild(liste)
}


// ---------------------------------------------------------------------------
// KI-Endprüfung
// ---------------------------------------------------------------------------

const PRUEF_KAT = { bug: 'Fehler', redundanz: 'Redundanz', sicherheit: 'Sicherheit', seo: 'SEO', technik: 'Technik' }

async function pruefungLaden () {
  if (!aktuell) return
  try {
    const b = await (await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/endpruefung`)).json()
    if (b && !b.fehler) pruefungZeichnen(b)
  } catch { /* dann eben leer */ }
}

function pruefungZeichnen (b) {
  const box = $('#pruefBericht')
  box.innerHTML = ''
  const st = b.statistik
  $('#pruefStatus').textContent = `Geprüft am ${new Date(b.am).toLocaleString('de-CH')} mit ${b.modell}`
    + ` — ${st.kritisch} kritisch, ${st.warnung} Warnungen, ${st.hinweis} Hinweise`
    + (b.verbrauch?.ein ? ` · ${(b.verbrauch.ein + b.verbrauch.aus).toLocaleString('de-CH')} Token` : '')
  const z = $('#pruefzahl')
  z.hidden = st.kritisch === 0
  z.textContent = st.kritisch

  if (!b.funde.length) {
    box.appendChild(el('div', 'tab-info', 'Keine Funde – der Build ist aus Sicht der Prüfung bereit für den Go-Live.'))
    return
  }
  const reihenfolge = { kritisch: 0, warnung: 1, hinweis: 2 }
  for (const fund of [...b.funde].sort((a, c) => reihenfolge[a.schwere] - reihenfolge[c.schwere])) {
    const karte = el('div', 'befund')
    const kopf = el('div', 'kopf')
    const marke = el('span', 'marke ' + (fund.schwere === 'kritisch' ? 'm-fehler' : fund.schwere === 'warnung' ? 'm-warnung' : 'm-hinweis'),
      fund.schwere === 'kritisch' ? 'Kritisch' : fund.schwere === 'warnung' ? 'Warnung' : 'Hinweis')
    kopf.appendChild(marke)
    const t = el('div', 't')
    t.appendChild(el('b', null, (PRUEF_KAT[fund.kategorie] || fund.kategorie) + ': ' + fund.titel))
    const wo = fund.datei ? fund.datei + ' — ' : ''
    t.appendChild(el('span', null, wo + fund.text + (fund.empfehlung ? ' → ' + fund.empfehlung : '')))
    kopf.appendChild(t)
    kopf.appendChild(el('span', 'marke ' + (fund.quelle === 'ki' ? 'm-hinweis' : 'm-ok'), fund.quelle === 'ki' ? 'KI' : 'Mechanisch'))
    kopf.appendChild(el('span', 'marke m-ok', 'Lösung ▾'))
    kopf.onclick = () => karte.classList.toggle('offen')
    karte.appendChild(kopf)

    const d = el('div', 'details')
    d.appendChild(loesungsBlock(pruefungsLoesung(fund)))
    karte.appendChild(d)
    box.appendChild(karte)
  }
}

// Entscheidet je Fund, wie man ihn behebt – inklusive der zwei Sonderfälle,
// die NICHT in den Chat gehören.
function pruefungsLoesung (fund) {
  // Sonderfall 1: config.php fehlt im Build – das ist Absicht, kein Fehler.
  if (/config\.php/.test(fund.datei) && /nicht vorhanden|fehlt/i.test(fund.titel + fund.text)) {
    return {
      art: 'automatisch',
      text: 'Fehlalarm mit Absicht: Diese Datei enthält Zugangsdaten und wird bewusst aus Build '
        + 'und Repo herausgehalten. Beim Deploy wird sie separat und geschützt auf den Server gelegt. '
        + 'Hier ist nichts zu tun.',
    }
  }
  // Sonderfall 2: Die .htaccess erzeugt VinWeb beim Build selbst.
  if (fund.datei === '.htaccess' && fund.quelle === 'ki') {
    return {
      art: 'hinweis',
      text: 'Diese Datei wird bei jedem Build von VinWeb neu erzeugt – eine Chat-Änderung würde '
        + 'überschrieben. Wirksame Ratenbegrenzung gehört auf Shared Hosting in den PHP-Code '
        + '(eigener Fund) bzw. in die VinWeb-Vorlage. Das gehört zu VinWeb selbst, nicht zu deiner Website.',
    }
  }
  // Regelfall: fertiger Chat-Prompt aus dem Fund.
  const zeilen = [
    `Behebe folgenden Fund aus der KI-Endprüfung (${PRUEF_KAT[fund.kategorie] || fund.kategorie}, ${fund.schwere})`
      + (fund.datei ? ` in ${fund.datei}:` : ':'),
    `«${fund.titel}» – ${fund.text}`,
    fund.empfehlung ? `Empfehlung der Prüfung: ${fund.empfehlung}` : null,
    fund.datei ? 'Hinweis: Der Dateiname stammt aus dem Build – in der Quelle kann er mit Grossbuchstaben geschrieben sein.' : null,
    'Wichtig: Das Verhalten für Besucher darf sich nicht ändern. Erkläre vor dem Dateiblock kurz, was du änderst und warum.',
  ].filter(Boolean)
  return {
    art: 'chat',
    text: fund.schwere === 'kritisch'
      ? 'Vor dem Go-Live beheben – am einfachsten mit dem vorbereiteten Prompt.'
      : 'Empfohlen, aber kein Go-Live-Blocker. Der vorbereitete Prompt erledigt es.',
    prompt: zeilen.join('\n'),
    promptErklaerung: 'Er übergibt der KI den exakten Fund samt Empfehlung der Prüfung, verbietet '
      + 'Verhaltensänderungen für Besucher und verlangt eine Erklärung vor dem Diff. Geschrieben wird '
      + 'erst, wenn du den Vorschlag per «Übernehmen» freigibst.',
  }
}

$('#btnPruefung').onclick = async () => {
  if (!aktuell) return status('Zuerst ein Projekt öffnen.', 'err')
  const knopf = $('#btnPruefung')
  knopf.disabled = true
  knopf.classList.add('laedt')
  banner('KI-Endprüfung läuft – mechanische Prüfung, dann zwei KI-Durchgänge …', 'laeuft')
  $('#pruefStatus').textContent = 'Prüfung startet …'
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/endpruefung`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anbieter: $('#anbieter').value, modell: $('#modell').value }),
    })
    const leser = antwort.body.getReader()
    const dekoder = new TextDecoder()
    let puffer = ''
    let bericht = null
    let fehler = null
    while (true) {
      const { done, value } = await leser.read()
      if (done) break
      puffer += dekoder.decode(value, { stream: true })
      let trenn
      while ((trenn = puffer.indexOf('\n\n')) >= 0) {
        const roh = puffer.slice(0, trenn); puffer = puffer.slice(trenn + 2)
        const art = (roh.split('\n').find(z => z.startsWith('event: ')) || '').slice(7)
        const daten = JSON.parse(roh.split('\n').filter(z => z.startsWith('data: ')).map(z => z.slice(6)).join(''))
        if (art === 'meldung') $('#pruefStatus').textContent = daten.t
        else if (art === 'fertig') bericht = daten
        else if (art === 'fehler') fehler = daten.text
      }
    }
    if (fehler) { $('#pruefStatus').textContent = fehler; status(fehler, 'err'); banner('✗ ' + fehler, 'fehler') }
    else if (bericht) {
      pruefungZeichnen(bericht)
      const st = bericht.statistik
      banner(st.kritisch === 0
        ? `✓ Endprüfung abgeschlossen: keine kritischen Funde (${st.warnung} Warnungen). Du kannst weitermachen.`
        : `Endprüfung abgeschlossen: ${st.kritisch} kritische(r) Fund(e) – unten anschauen.`, st.kritisch === 0 ? 'ok' : 'fehler')
      status('Endprüfung abgeschlossen.', 'ok')
      fortschrittLaden()
    }
  } catch (e) {
    $('#pruefStatus').textContent = 'Prüfung fehlgeschlagen: ' + e.message
    banner('✗ Prüfung fehlgeschlagen: ' + e.message, 'fehler')
  } finally {
    knopf.disabled = false
    knopf.classList.remove('laedt')
  }
}


/* ===========================================================================
   Baustein-Bibliothek (für VinWebMidi, Etappe 2)
   ===========================================================================
   VinWeb erntet aus fertigen Seiten die grossen Sektionen als Design-
   Bausteine. Hier werden sie geprüft, benannt, etikettiert und freigegeben -
   das Ergebnis (bibliothek.json im Projektordner) ist der Baukasten, aus dem
   VinWebMidi später per KI neue Unterseiten komponiert. */

let bausteinEtiketten = []   // Vokabular vom Server ({wert, name})

function bausteinApi (rest = '') {
  return `/api/projekte/${encodeURIComponent(aktuell.id)}/bausteine${rest}`
}

// Die Miniatur: die ECHTE Seite in einem iframe, per ?__baustein=<selektor>
// auf die eine Sektion reduziert (der Vorschau-Server injiziert das Skript
// dafür). Gerendert in Desktop-Breite, auf Kartenbreite herunterskaliert;
// die echte Höhe meldet die Seite per postMessage - siehe Empfänger unten.
function bausteinMiniatur (seite, selektor) {
  const box = el('div', 'bau-mini')
  box.dataset.sel = selektor
  const rahmen = el('div', 'bau-mini-rahmen')
  const ifr = document.createElement('iframe')
  ifr.loading = 'lazy'
  ifr.title = 'Miniatur der Sektion'
  ifr.src = `${VORSCHAU}/${encodeURIComponent(aktuell.id)}/`
    + seite.split('/').map(encodeURIComponent).join('/')
    + '?__baustein=' + encodeURIComponent(selektor)
  rahmen.appendChild(ifr)
  box.appendChild(rahmen)
  requestAnimationFrame(() => bausteinMiniSkalieren(box, null))
  return box
}

function bausteinMiniSkalieren (box, hoehe) {
  const breite = box.clientWidth || 360
  const k = breite / 1200
  if (hoehe != null) box.dataset.hoehe = hoehe
  const h = Number(box.dataset.hoehe) || 560
  box.style.height = Math.min(Math.max(h * k, 56), 440) + 'px'
  const rahmen = box.querySelector('.bau-mini-rahmen')
  rahmen.style.transform = `scale(${k})`
  rahmen.style.height = Math.max(h, 100) + 'px'
}

window.addEventListener('message', (e) => {
  if (e.origin !== VORSCHAU) return
  if (e.data?.typ !== 'vinweb-baustein-masse') return
  for (const box of document.querySelectorAll('.bau-mini')) {
    if (box.dataset.sel === e.data.sel) bausteinMiniSkalieren(box, e.data.hoehe)
  }
})

// Etiketten als anklickbare Chips - Klick schaltet um, meldet die Änderung.
function etikettenChips (gewaehlt, beiWechsel) {
  const box = el('div', 'bau-etiketten')
  for (const e of bausteinEtiketten) {
    const chip = el('button', 'bau-chip' + (gewaehlt.includes(e.wert) ? ' an' : ''), e.name)
    chip.type = 'button'
    chip.onclick = () => {
      const i = gewaehlt.indexOf(e.wert)
      if (i >= 0) gewaehlt.splice(i, 1)
      else gewaehlt.push(e.wert)
      chip.classList.toggle('an')
      if (beiWechsel) beiWechsel()
    }
    box.appendChild(chip)
  }
  return box
}

function bausteinInfo (b) {
  const teile = [b.zeichen + ' Zeichen']
  if (b.bilder) teile.push(b.bilder + (b.bilder === 1 ? ' Bild' : ' Bilder'))
  if (b.videos) teile.push(b.videos + ' Video(s)')
  teile.push((b.fuellstellen?.filter(f => f.aktiv).length || 0) + ' Füllstellen')
  return teile.join(' · ')
}

// Zählt nur für die Zahl im Menü - läuft bei jedem Projektwechsel.
async function bausteineZaehlen () {
  try {
    const d = await (await fetch(bausteinApi())).json()
    const zahl = (d.bausteine || []).length
    $('#bausteinzahl').textContent = zahl
    $('#bausteinzahl').hidden = zahl === 0
  } catch { /* Zahl ist Komfort - Fehler still übergehen */ }
}

async function bausteineLaden () {
  if (!aktuell) return
  const wahl = $('#bausteinSeite')
  wahl.innerHTML = ''
  for (const s of (aktuell.analyse?.seiten || [])) wahl.appendChild(new Option(s.rel, s.rel))
  if (aktuelleSeite && [...wahl.options].some(o => o.value === aktuelleSeite)) {
    wahl.value = aktuelleSeite
  }
  $('#bausteinVorschlaege').hidden = true
  $('#vorschlagListe').innerHTML = ''
  try {
    const d = await (await fetch(bausteinApi())).json()
    bausteinEtiketten = d.etiketten || []
    bibliothekZeichnen(d.bausteine || [])
  } catch (e) {
    $('#bausteinStatus').textContent = 'Bibliothek konnte nicht geladen werden: ' + e.message
  }
}

function bibliothekZeichnen (bausteine) {
  $('#bibliothekZahl').textContent = bausteine.length ? `(${bausteine.length})` : ''
  $('#bausteinzahl').textContent = bausteine.length
  $('#bausteinzahl').hidden = bausteine.length === 0
  const box = $('#bibliothekListe')
  box.innerHTML = ''
  if (!bausteine.length) {
    box.appendChild(el('p', 'bau-leer',
      'Noch keine Bausteine freigegeben. Wähle oben eine Seite und lass dir Sektionen vorschlagen.'))
    return
  }
  for (const b of bausteine) {
    const karte = el('div', 'bau-karte')
    karte.appendChild(bausteinMiniatur(b.seite, b.selektor))
    const felder = el('div', 'bau-felder')

    const name = document.createElement('input')
    name.type = 'text'
    name.className = 'bau-name'
    name.value = b.name
    name.maxLength = 80
    name.title = 'Kundenfreundlicher Name - so sieht ihn der Kunde in Midi'
    name.onchange = () => bausteinAendern(b.id, { name: name.value })
    felder.appendChild(name)

    felder.appendChild(el('div', 'bau-quelle', b.seite))
    const etiketten = [...(b.etiketten || [])]
    felder.appendChild(etikettenChips(etiketten,
      () => bausteinAendern(b.id, { etiketten })))
    felder.appendChild(el('div', 'bau-info-zeile', bausteinInfo(b)))

    const knoepfe = el('div', 'bau-knoepfe')
    const weg = el('button', 'btn klein', 'Aus Bibliothek entfernen')
    weg.title = 'Entfernt nur den Bibliothekseintrag - die Seite selbst bleibt unberührt.'
    weg.onclick = async () => {
      if (!confirm(`«${b.name}» aus der Bibliothek entfernen?`)) return
      const d = await (await fetch(bausteinApi('/' + encodeURIComponent(b.id)),
        { method: 'DELETE' })).json()
      if (d.fehler) return status(d.fehler, 'err')
      bausteineLaden()
    }
    knoepfe.appendChild(weg)
    felder.appendChild(knoepfe)

    karte.appendChild(felder)
    box.appendChild(karte)
  }
}

async function bausteinAendern (id, aenderung) {
  const d = await (await fetch(bausteinApi('/' + encodeURIComponent(id)), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(aenderung)
  })).json()
  if (d.fehler) status(d.fehler, 'err')
  else status('Baustein gespeichert.', 'ok')
}

$('#btnBausteinAnalyse').onclick = async () => {
  if (!aktuell) return
  const seite = $('#bausteinSeite').value
  if (!seite) return
  $('#bausteinStatus').textContent = 'Lese ' + seite + ' …'
  try {
    const d = await (await fetch(bausteinApi('/analyse'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ seite })
    })).json()
    if (d.fehler) { $('#bausteinStatus').textContent = d.fehler; return }
    vorschlaegeZeichnen(d.seite, d.kandidaten || [])
    $('#bausteinStatus').textContent = d.kandidaten.length
      ? `${d.kandidaten.length} Sektion(en) gefunden - prüfen, benennen, freigeben.`
      : 'Keine neuen Sektionen gefunden (schon freigegebene werden nicht nochmals vorgeschlagen).'
  } catch (e) {
    $('#bausteinStatus').textContent = 'Analyse fehlgeschlagen: ' + e.message
  }
}

function vorschlaegeZeichnen (seite, kandidaten) {
  $('#bausteinVorschlaege').hidden = kandidaten.length === 0
  $('#vorschlagZahl').textContent = `(${kandidaten.length} aus ${seite})`
  const box = $('#vorschlagListe')
  box.innerHTML = ''

  for (const k of kandidaten) {
    const karte = el('div', 'bau-karte vorschlag-karte')
    karte.appendChild(bausteinMiniatur(seite, k.selektor))
    const felder = el('div', 'bau-felder')

    const name = document.createElement('input')
    name.type = 'text'
    name.className = 'bau-name'
    name.value = k.name
    name.maxLength = 80
    name.title = 'Kundenfreundlicher Name - so sieht ihn der Kunde in Midi'
    felder.appendChild(name)

    const etiketten = [...(k.etiketten || [])]
    felder.appendChild(etikettenChips(etiketten))
    felder.appendChild(el('div', 'bau-info-zeile', bausteinInfo(k)))

    // Die Füllstellen: aufklappbar, einzeln abwählbar.
    const details = document.createElement('details')
    details.className = 'bau-fuellstellen'
    const zusammen = document.createElement('summary')
    zusammen.textContent = 'Füllstellen ansehen'
    details.appendChild(zusammen)
    for (const f of k.fuellstellen) {
      const zeile = el('label', 'bau-fuellstelle')
      const haken = document.createElement('input')
      haken.type = 'checkbox'
      haken.checked = f.aktiv
      haken.onchange = () => { f.aktiv = haken.checked }
      zeile.appendChild(haken)
      const text = el('span', null, f.beschreibung + (f.beispiel ? ` – „${f.beispiel}"` : ''))
      zeile.appendChild(text)
      details.appendChild(zeile)
    }
    felder.appendChild(details)

    const knoepfe = el('div', 'bau-knoepfe')
    const frei = el('button', 'btn klein primary', 'Freigeben')
    frei.onclick = async () => {
      frei.disabled = true
      const d = await (await fetch(bausteinApi(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          baustein: {
            name: name.value, seite, selektor: k.selektor, pfad: k.pfad,
            etiketten, fuellstellen: k.fuellstellen,
            zeichen: k.zeichen, bilder: k.bilder, videos: k.videos
          }
        })
      })).json()
      frei.disabled = false
      if (d.fehler) return status(d.fehler, 'err')
      karte.remove()
      if (!$('#vorschlagListe').children.length) $('#bausteinVorschlaege').hidden = true
      status(`«${d.baustein.name}» ist in der Bibliothek.`, 'ok')
      const bib = await (await fetch(bausteinApi())).json()
      bibliothekZeichnen(bib.bausteine || [])
    }
    knoepfe.appendChild(frei)
    const weg = el('button', 'btn klein', 'Verwerfen')
    weg.onclick = () => {
      karte.remove()
      if (!$('#vorschlagListe').children.length) $('#bausteinVorschlaege').hidden = true
    }
    knoepfe.appendChild(weg)
    felder.appendChild(knoepfe)

    karte.appendChild(felder)
    box.appendChild(karte)
  }
}


/* ===========================================================================
   Fernlager (GitHub) - Sync mit VinWebMini/Midi beim Kunden
   ===========================================================================
   Ein privates Repo pro Website ist die Drehscheibe: Der Kunde (Mini/Midi)
   schiebt seine Stände dorthin, VinWeb holt sie hier ab - und umgekehrt.
   Entscheid vom 05.09.2026; FTP/SSH bleibt reiner Deploy-Weg. */

let fernZustand = null   // { url, tokenDa, eingehend, ausgehend }

function fernApi (rest = '') {
  return `/api/projekte/${encodeURIComponent(aktuell.id)}/fernlager${rest}`
}

function fernZeichnen () {
  const z = fernZustand
  if (!z) return
  $('#fernVerbinden').hidden = Boolean(z.url)
  $('#fernVerbunden').hidden = !z.url
  $('#fernKonflikt').hidden = true
  if (!z.url) {
    $('#fernStand').textContent = '(nicht verbunden)'
    $('#fernVerbindenStatus').textContent = z.tokenDa
      ? ''
      : 'Hinweis: Es ist noch kein GitHub-Token hinterlegt - Zahnrad ⚙ in der KI-Spalte.'
    return
  }
  $('#fernUrlAnzeige').textContent = z.url.replace('https://github.com/', '')

  const teile = []
  if (z.wartend > 0) teile.push(`Kunde wartet: ${z.wartend} (Konflikt)`)
  if (z.eingehend > 0) teile.push(`Kunde: ${z.eingehend} neu`)
  if (z.ausgehend === null) teile.push('noch nie abgeglichen')
  else if (z.ausgehend > 0) teile.push(`du: ${z.ausgehend} nicht hochgeladen`)
  $('#fernStand').textContent = teile.length ? `(${teile.join(' · ')})` : '(auf gleichem Stand)'

  $('#btnFernUebernehmen').hidden = !(z.eingehend > 0 || z.wartend > 0)
  $('#btnFernHochladen').hidden = !(z.ausgehend === null || z.ausgehend > 0)
  $('#fernInfo').textContent = z.wartend > 0
    ? 'Die Kunden-Instanz konnte wegen eines Bearbeitungs-Konflikts nicht abgleichen - '
      + 'ihre Stände liegen im Wartezweig. «Übernehmen» führt sie zusammen; bei Konflikt entscheidest du per Knopf.'
    : (z.eingehend > 0
      ? 'Der Kunde hat Stände hochgeladen, die dir hier noch fehlen - «Übernehmen» holt sie in deinen Verlauf.'
      : (z.ausgehend ? 'Deine neuesten Stände sind noch nicht im Fernlager - «Hochladen» bringt sie dem Kunden.'
        : 'Alles im Gleichstand. Nach jedem gesicherten Stand lädt VinWeb automatisch hoch.'))
}

async function fernlagerLaden () {
  if (!aktuell) return
  try {
    fernZustand = await (await fetch(fernApi())).json()
  } catch {
    return   // Fernlager-Anzeige ist Komfort - die Arbeit geht auch ohne
  }
  fernZeichnen()
}

// still=true: Hintergrund-Abgleich beim Projektöffnen (meldet sich nur,
// wenn es wirklich Neues vom Kunden gibt).
async function fernAbgleichenJetzt (still) {
  if (!aktuell || !fernZustand?.url) return
  if (!still) status('Frage das Fernlager ab …')
  let d
  try {
    d = await (await fetch(fernApi('/abgleichen'), { method: 'POST' })).json()
  } catch {
    if (!still) status('Fernlager nicht erreichbar.', 'err')
    return
  }
  if (d.fehler) { if (!still) status(d.fehler, 'err'); return }
  Object.assign(fernZustand, d)
  fernZeichnen()
  if (d.wartend > 0) {
    status('Fernlager: Der Kunde wartet auf dich (Bearbeitungs-Konflikt) - unter «Verlauf» übernehmen.', 'err')
  } else if (d.eingehend > 0) {
    status(`Fernlager: ${d.eingehend} neue(r) Stand/Stände des Kunden - unter «Verlauf» übernehmen.`, 'err')
  } else if (!still) {
    status('Fernlager abgeglichen - keine neuen Kundenstände.', 'ok')
  }
}

$('#btnFernVerbinden').onclick = async () => {
  const url = $('#fernUrl').value.trim()
  if (!url) return
  $('#btnFernVerbinden').disabled = true
  $('#fernVerbindenStatus').textContent = 'Verbinde und lade den Verlauf hoch - beim ersten Mal kann das eine Weile dauern …'
  try {
    const d = await (await fetch(fernApi(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    })).json()
    if (d.fehler) { $('#fernVerbindenStatus').textContent = d.fehler; return }
    status('Fernlager verbunden - der komplette Verlauf ist hochgeladen.', 'ok')
    await fernlagerLaden()
  } finally {
    $('#btnFernVerbinden').disabled = false
  }
}

$('#btnFernAbgleichen').onclick = () => fernAbgleichenJetzt(false)

async function fernUebernehmenMit (strategie) {
  status('Übernehme die Kundenstände …')
  const d = await (await fetch(fernApi('/uebernehmen'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ strategie })
  })).json()
  if (d.fehler) return status(d.fehler, 'err')
  if (d.konflikt) {
    // Nichts wurde verändert - Reto entscheidet per Knopf, wer gewinnt.
    $('#fernKonflikt').hidden = false
    const liste = $('#fernKonfliktDateien')
    liste.innerHTML = ''
    for (const datei of d.dateien) liste.appendChild(el('li', null, datei))
    status('Bearbeitungs-Konflikt - bitte im Fernlager-Kasten entscheiden.', 'err')
    return
  }
  status('Kundenstände übernommen - der Verlauf ist jetzt gemeinsam.', 'ok')
  await projektOeffnen(aktuell.id)
  verlaufLaden()
  fernlagerLaden()
}

$('#btnFernUebernehmen').onclick = () => fernUebernehmenMit(null)
$('#btnFernMeine').onclick = () => fernUebernehmenMit('meine')
$('#btnFernKunde').onclick = () => fernUebernehmenMit('kunde')

$('#btnFernHochladen').onclick = async () => {
  status('Lade die lokalen Stände hoch …')
  const d = await (await fetch(fernApi('/hochladen'), { method: 'POST' })).json()
  if (d.fehler) return status(d.fehler, 'err')
  status('Hochgeladen - das Fernlager ist auf deinem Stand.', 'ok')
  Object.assign(fernZustand, d)
  fernZeichnen()
}

$('#btnFernTrennen').onclick = async () => {
  if (!confirm('Verbindung zum Fernlager lösen?\n\nDas Repo auf GitHub bleibt unberührt - nur dieses Projekt vergisst die Adresse.')) return
  await fetch(fernApi(), { method: 'DELETE' })
  status('Fernlager getrennt.', 'ok')
  fernlagerLaden()
}

// ---------------------------------------------------------------------------
// Design-Update: ZIP gegen das offene Projekt vergleichen und gezielt übernehmen
// ---------------------------------------------------------------------------

// Statuszeile direkt in der Karte – Feedback dort, wo man gerade arbeitet.
function vergleichStand (text, art) {
  const z = $('#vergleichStand')
  z.hidden = false
  z.className = 'karten-stand' + (art ? ' ' + art : '')
  z.textContent = text
}

function vergleichErgebnisMelden (m) {
  vergleichZeigen(m)
  const summe = m.neu.length + m.geaendert.length + m.konflikte.length
  vergleichStand(summe === 0
    ? `Fertig: keine Unterschiede – Projekt und ZIP sind inhaltlich gleich (${m.gleich} Dateien geprüft).`
    : `Fertig: ${m.neu.length} neu, ${m.geaendert.length} geändert, ${m.konflikte.length} Konflikt(e), `
      + `${m.gleich} unverändert. Auswahl im Fenster treffen.`)
}

// Weg 1: Dateiwähler oder Hineinziehen (empfohlen)
async function vergleichMitDatei (datei) {
  if (!aktuell) return vergleichStand('Zuerst links oben ein Projekt wählen.', 'fehler')
  if (!/\.zip$/i.test(datei.name)) return vergleichStand(datei.name + ' ist keine ZIP-Datei.', 'fehler')
  vergleichStand(`«${datei.name}» wird hochgeladen und verglichen …`, 'laeuft')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/vergleich-upload`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-dateiname': encodeURIComponent(datei.name) },
      body: datei,
    })
    const m = await antwort.json()
    if (!antwort.ok) throw new Error(m.fehler)
    vergleichErgebnisMelden(m)
  } catch (e) {
    vergleichStand('Vergleich fehlgeschlagen: ' + e.message, 'fehler')
  }
}

$('#vergleichDrop').onclick = () => $('#vergleichDatei').click()
$('#vergleichDatei').addEventListener('change', ev => {
  const f = ev.target.files && ev.target.files[0]
  ev.target.value = ''
  if (f) vergleichMitDatei(f)
})
$('#vergleichDrop').addEventListener('dragover', ev => { ev.preventDefault(); ev.currentTarget.classList.add('aktiv') })
$('#vergleichDrop').addEventListener('dragleave', ev => ev.currentTarget.classList.remove('aktiv'))
$('#vergleichDrop').addEventListener('drop', ev => {
  ev.preventDefault()
  ev.currentTarget.classList.remove('aktiv')
  const f = ev.dataTransfer.files && ev.dataTransfer.files[0]
  if (f) vergleichMitDatei(f)
})

// Weg 2: Pfad von Hand (bleibt als Alternative)
$('#btnVergleich').onclick = async () => {
  if (!aktuell) return vergleichStand('Zuerst links oben ein Projekt wählen.', 'fehler')
  const pfad = $('#vergleichPfad').value.trim()
  if (!pfad) return vergleichStand('Bitte ZIP hineinziehen, anklicken – oder einen Pfad angeben.', 'fehler')
  vergleichStand('Vergleiche …', 'laeuft')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/vergleich`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pfad }),
    })
    const m = await antwort.json()
    if (!antwort.ok) throw new Error(m.fehler)
    vergleichErgebnisMelden(m)
  } catch (e) {
    vergleichStand('Vergleich fehlgeschlagen: ' + e.message, 'fehler')
  }
}

function vergleichZeigen (m) {
  const alteOverlay = document.querySelector('.v-overlay')
  if (alteOverlay) alteOverlay.remove()

  const overlay = el('div', 'v-overlay')
  const dialog = el('div', 'v-dialog')
  dialog.appendChild(el('div', 'vd-kopf', `Design-Update aus ${m.zip}`))
  const inhalt = el('div', 'vd-inhalt')

  const gewaehlt = new Set()
  const gruppe = (titel, liste, vorgewaehlt, warnKlasse) => {
    if (!liste.length) return
    const g = el('div', 'v-gruppe')
    g.appendChild(el('h5', null, `${titel} (${liste.length})`))
    for (const d of liste) {
      const zeile = el('label', 'v-zeile' + (warnKlasse ? ' warn' : ''))
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = vorgewaehlt
      if (vorgewaehlt) gewaehlt.add(d.rel)
      cb.onchange = () => { cb.checked ? gewaehlt.add(d.rel) : gewaehlt.delete(d.rel) }
      zeile.appendChild(cb)
      zeile.appendChild(el('span', null, d.rel))
      zeile.appendChild(el('span', 'g', d.bytes < 1024 ? d.bytes + ' B' : Math.round(d.bytes / 1024) + ' KB'))
      g.appendChild(zeile)
    }
    inhalt.appendChild(g)
  }

  gruppe('Neu – im Projekt noch nicht vorhanden', m.neu, true, false)
  gruppe('Geändert – nur in Claude Design angepasst', m.geaendert, true, false)
  gruppe('⚠ Konflikt – auch in VinWeb geändert (Übernehmen überschreibt deine VinWeb-Arbeit)', m.konflikte, false, true)

  if (m.geloescht.length) {
    const g = el('div', 'v-gruppe')
    g.appendChild(el('h5', null, `Im ZIP nicht mehr vorhanden (${m.geloescht.length}) – wird NICHT automatisch gelöscht`))
    for (const rel of m.geloescht.slice(0, 20)) {
      const zeile = el('div', 'v-zeile')
      zeile.appendChild(el('span', null, rel))
      g.appendChild(zeile)
    }
    if (m.geloescht.length > 20) g.appendChild(el('div', 'v-zeile', `… und ${m.geloescht.length - 20} weitere`))
    inhalt.appendChild(g)
  }

  if (!m.neu.length && !m.geaendert.length && !m.konflikte.length) {
    inhalt.appendChild(el('p', 'karten-hinweis', 'Keine Unterschiede zum Übernehmen – Projekt und ZIP sind inhaltlich gleich.'))
  }
  dialog.appendChild(inhalt)

  const fuss = el('div', 'vd-fuss')
  const ok = el('button', 'btn klein primary', 'Auswahl übernehmen')
  ok.onclick = async () => {
    if (!gewaehlt.size) return status('Nichts ausgewählt.', 'err')
    ok.disabled = true
    try {
      const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/vergleich/uebernehmen`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ dateien: [...gewaehlt] }),
      })
      const d = await antwort.json()
      if (!antwort.ok) throw new Error(d.fehler)
      overlay.remove()
      banner(`✓ ${d.uebernommen.length} Datei(en) übernommen – im Verlauf gesichert. Weiter mit Build → Staging.`, 'ok')
      status(`${d.uebernommen.length} Datei(en) übernommen – als Stand im Verlauf gesichert.`, 'ok')
      vergleichStand(`✓ ${d.uebernommen.length} Datei(en) übernommen und im Verlauf gesichert. `
        + 'Nächster Schritt: Build erzeugen → Auf Staging stellen.')
      await projekteLaden(aktuell.id)
    } catch (e) {
      ok.disabled = false
      status('Übernahme fehlgeschlagen: ' + e.message, 'err')
    }
  }
  const abbruch = el('button', 'btn klein', 'Abbrechen')
  abbruch.onclick = () => overlay.remove()
  fuss.appendChild(ok)
  fuss.appendChild(abbruch)
  fuss.appendChild(el('span', 'karten-hinweis', `${m.gleich} Datei(en) unverändert`))
  dialog.appendChild(fuss)

  overlay.appendChild(dialog)
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove() }
  document.body.appendChild(overlay)
}

// ---------------------------------------------------------------------------
// Deploy: Build auf Staging stellen
// ---------------------------------------------------------------------------

function stagingKnoepfeZeigen () {
  const d = aktuell?.deploy
  const hat = Boolean(d?.host && d?.staging)
  $('#btnStaging').hidden = !hat
  $('#btnStagingOeffnen').hidden = !(hat && d.stagingUrl)
  if (d?.stagingUrl) $('#btnStagingOeffnen').href = d.stagingUrl
}

$('#btnStaging').onclick = async () => {
  if (!aktuell) return
  const knopf = $('#btnStaging')
  knopf.disabled = true
  knopf.textContent = 'Wird übertragen …'
  banner('Baue frisch und stelle auf Staging – dauert ~20 Sekunden …', 'laeuft')
  try {
    const antwort = await fetch(`/api/projekte/${encodeURIComponent(aktuell.id)}/deploy/staging`, { method: 'POST' })
    const d = await antwort.json()
    if (!antwort.ok) throw new Error(d.fehler)
    status(`Staging aktualisiert – ${d.uebertragen} Datei(en) übertragen. ` + (d.url ? d.url : ''), 'ok')
    banner(`✓ Staging aktualisiert (${d.uebertragen} Datei(en)). Jetzt «Staging öffnen» und prüfen.`, 'ok')
  } catch (e) {
    status('Staging-Deploy fehlgeschlagen: ' + e.message, 'err')
  } finally {
    knopf.disabled = false
    knopf.textContent = 'Auf Staging stellen'
  }
}
