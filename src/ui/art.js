// Original procedural illustrations for SATURN (authored for this project; no
// third-party assets). Each location kind gets a layered silhouette scene beneath
// a time-of-day sky crossed by the Great Ring — the setting's signature motif.

const SKIES = {
  dawn: ['#2b2140', '#a8576a', '#f2b27a'],
  morning: ['#4f7fae', '#9cc3df', '#f3e3c6'],
  afternoon: ['#3f6f9f', '#86b6d8', '#ecdcb8'],
  evening: ['#2a1f3d', '#8a3f55', '#e8955f'],
  night: ['#070b18', '#121c36', '#27304f'],
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rnd(seed) {
  let s = seed || 1;
  return () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return (s >>> 8) / 16777216; };
}

function ring(block) {
  const op = block === 'night' ? 0.85 : block === 'evening' || block === 'dawn' ? 0.6 : 0.4;
  return `<g opacity="${op}" transform="rotate(-14 400 70)">
    <ellipse cx="400" cy="70" rx="520" ry="34" fill="none" stroke="#f6e7c1" stroke-width="7" opacity="0.55"/>
    <ellipse cx="400" cy="70" rx="500" ry="30" fill="none" stroke="#d9c08a" stroke-width="3" opacity="0.6"/>
    <ellipse cx="400" cy="70" rx="545" ry="38" fill="none" stroke="#fff6dc" stroke-width="1.5" opacity="0.45"/>
  </g>`;
}

function stars(block, r) {
  if (block !== 'night' && block !== 'evening' && block !== 'dawn') return '';
  const n = block === 'night' ? 60 : 18;
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${(r() * 800).toFixed(1)}" cy="${(r() * 150).toFixed(1)}" r="${(r() * 1.3 + 0.3).toFixed(2)}" fill="#fff" opacity="${(r() * 0.6 + 0.2).toFixed(2)}"/>`;
  return s;
}

function hills(color, base, amp, r, step = 80) {
  let d = `M0 ${base}`;
  for (let x = 0; x <= 800; x += step) d += ` Q ${x + step / 2} ${base - amp * (0.4 + r())} ${x + step} ${base - amp * 0.2 * r()}`;
  return `<path d="${d} L800 300 L0 300 Z" fill="${color}"/>`;
}

function rooftops(color, base, r, { count = 9, tall = 60 } = {}) {
  let s = '';
  let x = -10;
  for (let i = 0; i < count; i++) {
    const w = 60 + r() * 50, h = 30 + r() * tall;
    s += `<rect x="${x.toFixed(0)}" y="${(base - h).toFixed(0)}" width="${w.toFixed(0)}" height="${(h + 40).toFixed(0)}" fill="${color}"/>`;
    s += `<polygon points="${x - 4},${base - h} ${x + w / 2},${base - h - 18 - r() * 16} ${x + w + 4},${base - h}" fill="${color}"/>`;
    if (r() > 0.4) s += `<rect x="${(x + w * 0.3).toFixed(0)}" y="${(base - h + 12).toFixed(0)}" width="8" height="11" fill="#f4c66b" opacity="0.75"/>`;
    if (r() > 0.6) s += `<rect x="${(x + w * 0.65).toFixed(0)}" y="${(base - h + 14).toFixed(0)}" width="8" height="11" fill="#f4c66b" opacity="0.6"/>`;
    x += w - 6;
  }
  return s;
}

function trees(color, base, r, n = 14, scale = 1) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = r() * 820 - 10, h = (50 + r() * 70) * scale, w = h * 0.45;
    s += `<polygon points="${x},${base} ${x + w / 2},${base - h} ${x + w},${base}" fill="${color}"/>`;
  }
  return s;
}

const FEATURES = {
  square: (r, c) => rooftops(c.mid, 230, r) + `<rect x="370" y="150" width="60" height="110" fill="${c.near}"/><circle cx="400" cy="140" r="26" fill="${c.near}"/><circle cx="400" cy="140" r="16" fill="#f3e3c6" opacity="0.8"/><line x1="400" y1="140" x2="400" y2="128" stroke="${c.near}" stroke-width="3"/>` + stalls(r, c),
  inn: (r, c) => rooftops(c.far, 210, r, { count: 7 }) + `<rect x="250" y="130" width="300" height="140" fill="${c.near}"/><polygon points="230,135 400,70 570,135" fill="${c.near}"/>${windows(270, 160, 6, 2, '#f7b955')}<rect x="385" y="205" width="34" height="65" fill="#3a2414"/><circle cx="560" cy="170" r="10" fill="#ffd27a"/><line x1="560" y1="150" x2="560" y2="160" stroke="${c.near}" stroke-width="3"/>`,
  docks: (r, c) => water(c, 220) + rooftops(c.mid, 205, r, { count: 6, tall: 30 }) + masts(r, c) + `<rect x="0" y="232" width="800" height="12" fill="${c.near}"/>${[60, 160, 260, 360, 460, 560, 660, 760].map((x) => `<rect x="${x}" y="232" width="8" height="40" fill="${c.near}"/>`).join('')}`,
  harbor: (r, c) => water(c, 200) + masts(r, c, 6) + `<path d="M0 240 L520 228 L560 240 L560 300 L0 300 Z" fill="${c.near}"/><rect x="600" y="120" width="30" height="110" fill="${c.mid}"/><polygon points="595,120 615,96 635,120" fill="${c.mid}"/><circle cx="615" cy="112" r="6" fill="#ffe08a"/>`,
  guild: (r, c) => rooftops(c.far, 220, r, { count: 8 }) + `<rect x="230" y="110" width="340" height="170" fill="${c.near}"/>${[250, 300, 350, 400, 450, 500, 540].map((x) => `<rect x="${x}" y="140" width="14" height="120" fill="${c.mid}"/>`).join('')}<polygon points="215,112 400,58 585,112" fill="${c.near}"/><circle cx="400" cy="92" r="14" fill="#d9b25a"/>`,
  archive: (r, c) => rooftops(c.far, 230, r, { count: 7 }) + `<rect x="350" y="40" width="100" height="240" fill="${c.near}"/><polygon points="340,42 400,4 460,42" fill="${c.near}"/><circle cx="400" cy="70" r="22" fill="none" stroke="#e7c983" stroke-width="3"/><ellipse cx="400" cy="70" rx="34" ry="8" fill="none" stroke="#e7c983" stroke-width="2" transform="rotate(-20 400 70)"/>${windows(368, 110, 3, 5, '#f7c76a', 22, 30)}`,
  forge: (r, c) => rooftops(c.mid, 230, r, { count: 7 }) + `<rect x="260" y="140" width="280" height="140" fill="${c.near}"/><polygon points="250,142 400,96 550,142" fill="${c.near}"/><rect x="470" y="70" width="34" height="80" fill="${c.near}"/><rect x="330" y="190" width="140" height="80" fill="#ff7a2a" opacity="0.85"/><rect x="330" y="190" width="140" height="80" fill="url(#glow)"/><path d="M380 250 h50 v10 h-10 v15 h-30 v-15 h-10 z" fill="#1a1110"/>${smoke(487, 60, r)}`,
  temple: (r, c) => trees(c.mid, 250, r, 10, 0.8) + `<rect x="290" y="150" width="220" height="130" fill="${c.near}"/><path d="M280 152 Q400 50 520 152 Z" fill="${c.near}"/><path d="M330 150 Q400 95 470 150" fill="none" stroke="#e9e3d0" stroke-width="3"/>${[310, 360, 410, 460].map((x) => `<rect x="${x}" y="165" width="16" height="110" fill="${c.mid}"/>`).join('')}`,
  hall: (r, c) => rooftops(c.far, 225, r, { count: 8 }) + `<rect x="220" y="120" width="360" height="160" fill="${c.near}"/><polygon points="205,122 400,62 595,122" fill="${c.near}"/>${[245, 300, 355, 410, 465, 520].map((x) => `<rect x="${x}" y="145" width="18" height="125" fill="${c.mid}"/>`).join('')}<rect x="385" y="30" width="30" height="40" fill="${c.near}"/><polygon points="380,30 400,10 420,30" fill="${c.near}"/>`,
  narrows: (r, c) => `${rooftops(c.mid, 180, r, { count: 6, tall: 90 })}<rect x="0" y="0" width="230" height="300" fill="${c.near}"/><rect x="570" y="0" width="230" height="300" fill="${c.near}"/>${windows(40, 60, 3, 4, '#d99a4a', 50, 50)}${windows(600, 70, 3, 4, '#d99a4a', 50, 50)}<path d="M230 300 L330 140 L470 140 L570 300 Z" fill="#1d1712" opacity="0.6"/>`,
  mill: (r, c) => hills(c.far, 210, 50, r) + water(c, 250) + `<rect x="300" y="120" width="170" height="150" fill="${c.near}"/><polygon points="290,122 385,70 480,122" fill="${c.near}"/><g transform="translate(250 200)"><circle r="62" fill="none" stroke="${c.near}" stroke-width="9"/>${Array.from({ length: 8 }, (_, i) => `<line x1="0" y1="0" x2="${Math.cos(i * 0.785) * 62}" y2="${Math.sin(i * 0.785) * 62}" stroke="${c.near}" stroke-width="6"/>`).join('')}</g><rect x="520" y="170" width="120" height="100" fill="${c.mid}"/><rect x="560" y="215" width="40" height="55" fill="#2a1d14"/><path d="M560 230 h40 M560 245 h40" stroke="#9b8a6a" stroke-width="3"/>`,
  fields: (r, c) => hills(c.far, 190, 40, r, 120) + `${Array.from({ length: 9 }, (_, i) => `<path d="M${-100 + i * 110} 300 Q 400 ${200 + i * 2} ${900 - i * 40} 210" fill="none" stroke="${c.mid}" stroke-width="3" opacity="0.7"/>`).join('')}<rect x="560" y="150" width="120" height="70" fill="${c.near}"/><polygon points="550,152 620,110 690,152" fill="${c.near}"/><rect x="600" y="185" width="22" height="35" fill="#3a2a1a"/>`,
  forest: (r, c) => trees(c.far, 230, r, 22, 1.1) + trees(c.mid, 260, r, 16, 1.4) + trees(c.near, 300, r, 9, 2),
  ruin: (r, c) => trees(c.far, 240, r, 18, 1.1) + `<path d="M230 280 Q400 60 570 280 Z" fill="${c.near}"/><path d="M300 280 Q400 140 500 280" fill="none" stroke="#5f7a5f" stroke-width="4"/><path d="M360 120 l20 30 l-15 25 l25 20" fill="none" stroke="#9fd8c4" stroke-width="2" opacity="0.8"/>` + trees(c.near, 300, r, 6, 1.8),
  fishmarket: (r, c) => `${rooftops(c.far, 210, r, { count: 7, tall: 40 })}<rect x="80" y="120" width="640" height="18" fill="${c.near}"/>${[100, 220, 340, 460, 580, 690].map((x) => `<rect x="${x}" y="136" width="12" height="150" fill="${c.near}"/>`).join('')}<polygon points="60,122 400,70 740,122" fill="${c.near}"/>${stalls(r, c, 250)}`,
};

function windows(x0, y0, cols, rows, color, dx = 45, dy = 40) {
  let s = '';
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) s += `<rect x="${x0 + i * dx}" y="${y0 + j * dy}" width="16" height="20" fill="${color}" opacity="0.8"/>`;
  return s;
}
function stalls(r, c, base = 268) {
  let s = '';
  for (let i = 0; i < 6; i++) {
    const x = 40 + i * 125 + r() * 20;
    const hue = ['#b4513a', '#d1a54b', '#4f7b6a', '#8a4f7b', '#c2793e', '#557aa0'][i];
    s += `<rect x="${x}" y="${base - 30}" width="80" height="30" fill="${c.near}"/><path d="M${x - 6} ${base - 30} L${x + 40} ${base - 52} L${x + 86} ${base - 30} Z" fill="${hue}" opacity="0.9"/>`;
  }
  return s;
}
function water(c, y) {
  return `<rect x="0" y="${y}" width="800" height="${300 - y}" fill="${c.water}"/>${Array.from({ length: 7 }, (_, i) => `<path d="M${i * 120} ${y + 18 + (i % 3) * 14} q30 -6 60 0" stroke="#ffffff" stroke-opacity="0.25" fill="none" stroke-width="2"/>`).join('')}`;
}
function masts(r, c, n = 4) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const x = 80 + i * (640 / n) + r() * 40;
    s += `<path d="M${x - 40} 235 Q${x} 255 ${x + 50} 235 Z" fill="${c.near}"/><line x1="${x}" y1="235" x2="${x}" y2="${120 + r() * 40}" stroke="${c.near}" stroke-width="4"/><path d="M${x + 3} ${140 + r() * 20} L${x + 45} 210 L${x + 3} 210 Z" fill="#e9dcc0" opacity="0.75"/>`;
  }
  return s;
}
function smoke(x, y, r) {
  let s = '';
  for (let i = 0; i < 5; i++) s += `<circle cx="${x + i * 8 + r() * 6}" cy="${y - i * 14}" r="${8 + i * 3}" fill="#bbb" opacity="${0.35 - i * 0.05}"/>`;
  return s;
}

const PALETTES = {
  default: { far: '#5b5f76', mid: '#3d4058', near: '#22243a', water: '#35567a' },
  night: { far: '#1f2540', mid: '#151a30', near: '#0b0e1d', water: '#132036' },
  warm: { far: '#7a5a52', mid: '#4f3a3c', near: '#2a1f24', water: '#4a5e78' },
  green: { far: '#4c6a58', mid: '#2f4a3c', near: '#18291f', water: '#2e5463' },
};

export function sceneSVG(kind, block = 'morning', key = '') {
  const sky = SKIES[block] || SKIES.morning;
  const r = rnd(hash(kind + key));
  const pal = block === 'night' ? PALETTES.night : ['forest', 'ruin', 'fields', 'temple'].includes(kind) ? PALETTES.green : block === 'evening' || block === 'dawn' ? PALETTES.warm : PALETTES.default;
  const feature = (FEATURES[kind] || FEATURES.square)(r, pal);
  const sun = block === 'night' ? `<circle cx="640" cy="60" r="16" fill="#f0ead2" opacity="0.9"/>` : block === 'evening' ? `<circle cx="660" cy="170" r="30" fill="#ffb067" opacity="0.9"/>` : block === 'dawn' ? `<circle cx="140" cy="175" r="28" fill="#ffd08a" opacity="0.9"/>` : `<circle cx="660" cy="52" r="22" fill="#fff4cf" opacity="0.9"/>`;
  return `<svg viewBox="0 0 800 300" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${kind} at ${block}">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky[0]}"/><stop offset="0.6" stop-color="${sky[1]}"/><stop offset="1" stop-color="${sky[2]}"/></linearGradient>
      <radialGradient id="glow" cx="0.5" cy="0.6" r="0.6"><stop offset="0" stop-color="#ffd27a" stop-opacity="0.9"/><stop offset="1" stop-color="#ff5a1a" stop-opacity="0"/></radialGradient>
      <linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#0d0f17" stop-opacity="0.9"/></linearGradient>
    </defs>
    <rect width="800" height="300" fill="url(#sky)"/>
    ${stars(block, r)}${sun}${ring(block)}
    ${hills(pal.far, 240, 40, r)}
    ${feature}
    <rect width="800" height="300" fill="url(#fade)"/>
  </svg>`;
}

/** A portrait medallion: initials on a colour derived from the name. */
export function portraitSVG(name, size = 40) {
  const h = hash(name);
  const hue = h % 360;
  const initials = name.split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <defs><linearGradient id="pg${h}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue} 45% 42%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360} 50% 22%)"/></linearGradient></defs>
    <circle cx="20" cy="20" r="19" fill="url(#pg${h})" stroke="#d9b25a" stroke-width="1.2"/>
    <ellipse cx="20" cy="20" rx="19" ry="5" fill="none" stroke="#f6e7c1" stroke-opacity="0.35" transform="rotate(-18 20 20)"/>
    <text x="20" y="25" text-anchor="middle" font-family="Georgia, serif" font-size="14" fill="#fbf3dc">${initials}</text>
  </svg>`;
}

export const LOGO = `<svg viewBox="0 0 64 64" width="30" height="30" aria-hidden="true"><circle cx="32" cy="32" r="14" fill="#d9b25a"/><ellipse cx="32" cy="32" rx="28" ry="8" fill="none" stroke="#f6e7c1" stroke-width="3" transform="rotate(-20 32 32)"/><path d="M18 30 a14 14 0 0 1 28 0" fill="#b8913d" opacity="0.6"/></svg>`;
