let iconSequence = 0;

function shade(hex, amount) {
  const rgb = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
  const target = amount > 0 ? 255 : 0;
  return '#' + rgb.map(channel => Math.round(channel + (target - channel) * Math.abs(amount)).toString(16).padStart(2, '0')).join('');
}

/** Self-contained, code-native icons. All colour interpolation is restricted to hex. */
export function shapeIcon(type, color = '#ee8765') {
  const base = /^#[\da-f]{6}$/i.test(color) ? color : '#ee8765';
  const light = shade(base, .38), lit = shade(base, .18), dark = shade(base, -.18), deep = shade(base, -.34);
  const id = `solid-shape-${++iconSequence}`;
  const defs = `<defs><linearGradient id="${id}-side" x1="0" x2="1"><stop stop-color="${lit}"/><stop offset=".42" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/></linearGradient><radialGradient id="${id}-ball" cx="30%" cy="24%" r="77%"><stop stop-color="${light}"/><stop offset=".54" stop-color="${base}"/><stop offset="1" stop-color="${dark}"/></radialGradient></defs>`;
  const fill = `url(#${id}-side)`, ball = `url(#${id}-ball)`;
  const p = (d, c, extra = '') => `<path d="${d}" fill="${c}" ${extra}/>`;
  const ellipse = (cx, cy, rx, ry, c, extra = '') => `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${c}" ${extra}/>`;
  let art = '';
  switch (type) {
    case 'box':
      art = p('M12 17 32 7 52 17 32 28Z', light) + p('M12 17 32 28V47L12 36Z', base) + p('M32 28 52 17V36L32 47Z', dark);
      break;
    case 'roundedBox':
      art = p('M12 18Q12 15 16 13L29 7Q32 5 36 7L49 13Q53 15 53 18V34Q53 37 49 39L36 46Q32 48 28 46L15 39Q11 37 11 33Z', fill)
        + p('M13 16Q12 18 16 20L28 26Q32 28 36 26L49 20Q53 18 49 15L36 8Q32 6 28 8L16 14Z', light)
        + p('M32 29V45Q34 45 37 43L49 37Q51 36 51 33V21L36 28Q34 29 32 29Z', dark, 'opacity=".65"');
      break;
    case 'cylinder':
      art = p('M13 16V37C13 49 51 49 51 37V16Z', fill) + ellipse(32, 16, 19, 9, light) + p('M16 17C18 23 38 26 49 18', 'none', `stroke="${lit}" stroke-width=".65"`);
      break;
    case 'sphere':
      art = `<circle cx="32" cy="26" r="20" fill="${ball}"/>` + ellipse(24, 15, 6, 3.6, '#ffffff', 'opacity=".13" transform="rotate(-25 24 15)"');
      break;
    case 'cone':
      art = p('M32 5 12 37C12 49 52 49 52 37Z', fill)
        + p('M32 5 32 45C42 45 52 42 52 37Z', dark, 'opacity=".24"')
        + p('M16 38Q32 48 48 38', 'none', `stroke="${deep}" stroke-opacity=".17" stroke-width=".7"`);
      break;
    case 'tube':
      art = p('M12 16V37C12 49 52 49 52 37V16Z', fill)
        + ellipse(32, 16, 20, 9, light)
        + ellipse(32, 16, 13.5, 5.7, deep)
        + p('M18.5 16C19 10 45 10 45.5 16V19C40 25 24 25 18.5 19Z', dark)
        + p('M12 16C12 4 52 4 52 16C52 28 12 28 12 16ZM18.5 16C18.5 23.6 45.5 23.6 45.5 16C45.5 8.4 18.5 8.4 18.5 16Z', light, 'fill-rule="evenodd"');
      break;
    case 'torus':
      art = p('M10 27C10 8 54 8 54 27V30C54 49 10 49 10 30ZM22 27C22 33 42 33 42 27C42 21 22 21 22 27Z', dark, 'fill-rule="evenodd"')
        + p('M10 25C10 7 54 7 54 25C54 43 10 43 10 25ZM22 25C22 32.6 42 32.6 42 25C42 17.4 22 17.4 22 25Z', fill, 'fill-rule="evenodd"')
        + p('M13 23C14 12 44 7 51 22', 'none', `stroke="${light}" stroke-width="2.5" stroke-linecap="round" opacity=".6"`);
      break;
    case 'wedge':
      art = p('M11 35 35 47 35 15Z', base)
        + p('M35 15 53 6V37L35 47Z', dark)
        + p('M11 35 29 26 53 6 35 15Z', light);
      break;
    case 'pyramid':
      art = p('M32 5 10 36 32 47Z', lit) + p('M32 5 54 36 32 47Z', dark);
      break;
    case 'polygon': {
      const top = [[52, 18], [42, 27], [22, 27], [12, 18], [22, 9], [42, 9]];
      for (let i = 0; i < 3; i++) {
        const a = top[i], b = top[i + 1];
        art += p(`M${a[0]} ${a[1]} ${b[0]} ${b[1]} ${b[0]} ${b[1] + 19} ${a[0]} ${a[1] + 19}Z`, [dark, base, lit][i]);
      }
      art += p(`M${top.map(point => point.join(' ')).join(' ')}Z`, light);
      break;
    }
    case 'capsule':
      art = p('M18 18C18 1 46 1 46 18V34C46 52 18 52 18 34Z', fill)
        + p('M20 18C20 5 44 5 44 18C44 30 20 30 20 18Z', light, 'opacity=".42"')
        + p('M23 17C23 12 26 9 30 9', 'none', 'stroke="#fff" stroke-opacity=".2" stroke-width="2.5" stroke-linecap="round"');
      break;
    case 'gear': {
      const points = [];
      for (let tooth = 0; tooth < 10; tooth++) for (let corner = 0; corner < 4; corner++) {
        const angle = (tooth + corner / 4) * Math.PI / 5;
        const radius = corner === 0 || corner === 3 ? .79 : 1;
        points.push([32 + 23 * radius * Math.cos(angle), 22 + 13 * radius * Math.sin(angle)]);
      }
      const outline = (offset = 0) => `M${points.map(point => `${point[0].toFixed(2)} ${(point[1] + offset).toFixed(2)}`).join(' ')}Z`;
      art = p(outline(9), dark) + p(outline(4), base) + p(outline(), light)
        + ellipse(32, 22, 7.5, 4.5, deep) + p('M24.5 22C26 18 38 18 39.5 22C37 24 27 24 24.5 22Z', dark);
      break;
    }
    case 'mesh':
      art = p('M31 6 47 13 54 29 42 43 24 46 10 32 14 16Z', base)
        + p('M31 6 14 16 31 22Z', light)
        + p('M31 6 47 13 31 22Z', lit)
        + p('M47 13 54 29 31 22Z', dark)
        + p('M14 16 10 32 31 22Z', lit)
        + p('M10 32 24 46 31 22Z', base)
        + p('M31 22 24 46 42 43Z', dark)
        + p('M31 22 42 43 54 29Z', deep)
        + p('M14 16 31 22 47 13M10 32 31 22 54 29M24 46 31 22 31 6M31 22 42 43', 'none', 'stroke="#fff" stroke-opacity=".25" stroke-width=".65"');
      break;
    case 'boolean':
    case 'union':
      art = p('M8 22 25 13 42 22 25 31Z', light)
        + p('M8 22 25 31V46L8 37Z', base)
        + p('M25 31 42 22V37L25 46Z', dark)
        + p('M25 15V32C25 42 55 42 55 32V15Z', fill)
        + ellipse(40, 15, 15, 7.5, light);
      break;
    default:
      art = p('M12 17 32 7 52 17 32 28Z', light) + p('M12 17 32 28V47L12 36Z', base) + p('M32 28 52 17V36L32 47Z', dark);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 54" fill="none" stroke="none" aria-hidden="true" focusable="false">${defs}<ellipse cx="32" cy="47" rx="22" ry="4" fill="#414b48" opacity=".07"/>${art}</svg>`;
}
