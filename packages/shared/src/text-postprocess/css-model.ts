import {
  TEXT_POSTPROCESS_CLASS_TOKEN,
  TEXT_POSTPROCESS_HTML_TAGS,
  TEXT_POSTPROCESS_THEME_COLOR_VARS,
  TEXT_POSTPROCESS_THEME_RADIUS_VAR,
  type CssDeclaration,
  type CssRule,
  type CssSelector,
  type CssToken,
  type TextPostprocessHtmlTag,
} from '../api/text-postprocess';

const NAMED_COLORS = new Set(
  `transparent currentcolor black white red green blue gray grey yellow orange purple
  pink brown cyan magenta lime navy teal silver maroon olive aqua fuchsia
  aliceblue antiquewhite aquamarine azure beige bisque blanchedalmond blueviolet
  burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson
  darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta
  darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
  darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray
  dimgrey dodgerblue firebrick floralwhite forestgreen gainsboro ghostwhite gold
  goldenrod greenyellow honeydew hotpink indianred indigo ivory khaki lavender
  lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan
  lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon
  lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue
  lightyellow limegreen linen mediumaquamarine mediumblue mediumorchid
  mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
  mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite oldlace
  olivedrab orangered orchid palegoldenrod palegreen paleturquoise palevioletred
  papayawhip peachpuff peru plum powderblue rosybrown royalblue saddlebrown
  salmon sandybrown seagreen seashell sienna skyblue slateblue slategray slategrey
  snow springgreen steelblue tan thistle tomato turquoise violet wheat whitesmoke
  yellowgreen`
    .split(/\s+/)
    .filter((name) => name.length > 0)
);

const ALIGN = new Set([
  'flex-start',
  'flex-end',
  'center',
  'stretch',
  'baseline',
  'start',
  'end',
  'normal',
]);
const JUSTIFY = new Set([...ALIGN, 'space-between', 'space-around', 'space-evenly']);
const ROOT_PX = 16;

export interface CssCheckContext {
  mentionsButton: boolean;
}

export function selectorMentionsButton(selectors: CssSelector[]): boolean {
  return selectors.some((selector) =>
    selector.compounds.some((compound) => compound.tag === 'button')
  );
}

export function checkSelector(selector: CssSelector): boolean {
  if (selector.compounds.length === 0 || selector.compounds[0]?.combinator !== null) return false;
  return selector.compounds.every((compound, index) => {
    if (index > 0 && compound.combinator === null) return false;
    if (compound.tag === null && compound.classes.length === 0) return false;
    if (compound.tag !== null && !isHtmlTag(compound.tag)) return false;
    if (!compound.classes.every((token) => TEXT_POSTPROCESS_CLASS_TOKEN.test(token))) return false;
    return compound.pseudos.every((pseudo) => {
      if (pseudo.kind !== 'nth-child') return true;
      if (pseudo.a !== null && (!Number.isInteger(pseudo.a) || pseudo.a < -10 || pseudo.a > 10)) {
        return false;
      }
      return Number.isInteger(pseudo.b) && pseudo.b >= 0 && pseudo.b <= 20;
    });
  });
}

export function checkCssRule(rule: CssRule): boolean {
  if (rule.type === 'media') {
    if (rule.conditions.length < 1 || rule.conditions.length > 2) return false;
    const kinds = new Set(rule.conditions.map((condition) => condition.type));
    if (kinds.size !== rule.conditions.length) return false;
    return rule.rules.every((style) => checkCssRule(style));
  }
  if (!rule.selectors.every((selector) => checkSelector(selector))) return false;
  const button = selectorMentionsButton(rule.selectors);
  return rule.declarations.every((declaration) =>
    checkDeclaration(declaration, { mentionsButton: button })
  );
}

export function checkDeclaration(declaration: CssDeclaration, context: CssCheckContext): boolean {
  return checkTokens(declaration.property, declaration.tokens, context) === null;
}

function checkTokens(
  property: CssDeclaration['property'],
  tokens: CssToken[],
  context: CssCheckContext
): string | null {
  switch (property) {
    case 'color':
      return checkColorProperty(tokens, context.mentionsButton);
    case 'background-color':
    case 'border-color':
      return everyPart(splitCommas(tokens), (part) => isColor(part, false), 1, 4);
    case 'background':
      return checkBackground(tokens, context.mentionsButton);
    case 'font-family':
      return checkFontFamily(tokens);
    case 'font-size':
      return checkLengthRange(tokens, 12, 32, false);
    case 'font-style':
      return identOnly(tokens, ['normal', 'italic', 'oblique']);
    case 'font-weight':
      return checkFontWeight(tokens);
    case 'line-height':
      return checkLineHeight(tokens);
    case 'letter-spacing':
      return checkLetterSpacing(tokens);
    case 'text-align':
      return identOnly(tokens, ['left', 'right', 'center', 'start', 'end', 'justify']);
    case 'text-decoration':
      return identOnly(tokens, ['none', 'underline', 'line-through', 'overline']);
    case 'text-transform':
      return identOnly(tokens, ['none', 'uppercase', 'lowercase', 'capitalize']);
    case 'white-space':
      return identOnly(tokens, ['normal', 'nowrap', 'pre-wrap', 'pre-line']);
    case 'overflow-wrap':
      return identOnly(tokens, ['normal', 'anywhere', 'break-word']);
    case 'word-break':
      return identOnly(tokens, ['normal', 'break-all', 'keep-all', 'break-word']);
    case 'border-style':
      return everyPart(
        splitCommas(tokens).length === 1 ? splitSpaces(tokens) : splitCommas(tokens),
        (part) => identOnly(part, ['none', 'solid', 'dashed', 'dotted', 'double']) === null,
        1,
        4
      );
    case 'border-width':
      return checkBoxEdges(tokens, 0, 4);
    case 'border-radius':
      return checkRadius(tokens);
    case 'border':
      return checkBorder(tokens);
    case 'box-shadow':
      return checkShadow(tokens);
    case 'box-sizing':
      return identOnly(tokens, ['content-box', 'border-box']);
    case 'width':
    case 'min-width':
    case 'max-width':
    case 'height':
    case 'min-height':
    case 'max-height':
      return checkBoxSize(tokens);
    case 'margin':
      return checkMargin(tokens);
    case 'padding':
      return checkBoxEdges(tokens, 0, 32);
    case 'overflow':
    case 'overflow-x':
    case 'overflow-y':
      return identOnly(tokens, ['visible', 'hidden', 'auto']);
    case 'display':
      return identOnly(tokens, [
        'block',
        'inline',
        'inline-block',
        'flex',
        'inline-flex',
        'grid',
        'inline-grid',
        'table',
        'table-row',
        'table-cell',
        'table-header-group',
        'table-row-group',
      ]);
    case 'flex':
      return checkFlex(tokens);
    case 'flex-basis':
      return checkBasis(tokens);
    case 'flex-direction':
      return identOnly(tokens, ['row', 'column', 'row-reverse', 'column-reverse']);
    case 'flex-grow':
    case 'flex-shrink':
      return checkUnitless(tokens, 0, 4);
    case 'flex-wrap':
      return identOnly(tokens, ['nowrap', 'wrap']);
    case 'align-items':
    case 'align-self':
      return identOnly(tokens, [...ALIGN]);
    case 'align-content':
    case 'justify-content':
      return identOnly(tokens, [...JUSTIFY]);
    case 'justify-items':
    case 'justify-self':
      return identOnly(tokens, ['start', 'end', 'center', 'stretch', 'normal']);
    case 'gap':
    case 'row-gap':
    case 'column-gap':
      return checkBoxEdges(tokens, 0, 24);
    case 'grid-template-columns':
      return checkGridColumns(tokens);
    case 'grid-auto-flow':
      return identOnly(tokens, ['row', 'column']);
    case 'place-items':
      return checkPlaceItems(tokens);
    case 'list-style':
      return checkListStyle(tokens);
    case 'list-style-position':
      return identOnly(tokens, ['inside', 'outside']);
    case 'border-collapse':
      return identOnly(tokens, ['collapse', 'separate']);
    case 'border-spacing':
      return checkBoxEdges(tokens, 0, 16);
    case 'table-layout':
      return identOnly(tokens, ['auto', 'fixed']);
    case 'vertical-align':
      return identOnly(tokens, ['baseline', 'top', 'middle', 'bottom']);
    case 'transition-property':
      return everyPart(
        splitCommas(tokens),
        (part) =>
          identOnly(part, [
            'color',
            'background-color',
            'border-color',
            'box-shadow',
            'opacity',
          ]) === null,
        1,
        5
      );
    case 'transition-duration':
    case 'transition-delay':
      return checkTimeList(tokens);
    case 'transition-timing-function':
      return everyPart(
        splitCommas(tokens),
        (part) =>
          identOnly(part, ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out']) === null,
        1,
        5
      );
    default:
      return 'FORBIDDEN_PROPERTY';
  }
}

function checkColorProperty(tokens: CssToken[], rejectTransparent: boolean): string | null {
  if (!isColor(tokens, rejectTransparent)) return 'FORBIDDEN_VALUE';
  return null;
}

function checkBackground(tokens: CssToken[], rejectTransparent: boolean): string | null {
  if (tokens.length === 1 && tokens[0]?.t === 'function' && tokens[0].name === 'linear-gradient') {
    return checkGradient(tokens[0].args) ? null : 'FORBIDDEN_VALUE';
  }
  return isColor(tokens, rejectTransparent) ? null : 'FORBIDDEN_VALUE';
}

function checkGradient(args: CssToken[]): boolean {
  let index = 0;
  if (args[0]?.t === 'ident' && args[0].v === 'to') {
    const first = args[1];
    const second = args[2];
    if (!first || first.t !== 'ident' || !['top', 'bottom', 'left', 'right'].includes(first.v)) {
      return false;
    }
    index = 2;
    if (second?.t === 'ident' && ['top', 'bottom', 'left', 'right'].includes(second.v)) index = 3;
  } else if (args[0]?.t === 'dimension' && args[0].u === 'deg') {
    const angle = numeric(args[0].v);
    if (angle === null || angle < 0 || angle > 360) return false;
    index = 1;
  }
  const stops: CssToken[][] = [];
  let current: CssToken[] = [];
  for (const token of args.slice(index)) {
    if (token.t === 'operator' && token.v === ',') {
      if (current.length === 0) return false;
      stops.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }
  if (current.length > 0) stops.push(current);
  if (stops.length < 2 || stops.length > 4) return false;
  return stops.every((stop) => {
    if (isColor([stop[0] as CssToken], false) && stop.length === 1) return true;
    if (stop.length === 2 && isColor([stop[0] as CssToken], false)) {
      const position = stop[1];
      if (!position) return false;
      if (position.t === 'percentage') {
        const value = numeric(position.v);
        return value !== null && value >= 0 && value <= 100;
      }
      const px = lengthPx(position);
      return px !== null && px >= 0 && px <= 640;
    }
    return false;
  });
}

function isColor(tokens: CssToken[], rejectTransparent: boolean): boolean {
  if (tokens.length !== 1) return false;
  const token = tokens[0];
  if (!token) return false;
  if (token.t === 'ident') {
    const name = token.v.toLowerCase();
    if (!NAMED_COLORS.has(name)) return false;
    if (rejectTransparent && name === 'transparent') return false;
    return true;
  }
  if (token.t === 'hash') {
    const alpha = hexAlpha(token.v);
    if (alpha === null) return false;
    if (rejectTransparent && alpha === 0) return false;
    return true;
  }
  if (token.t === 'function' && (token.name === 'rgb' || token.name === 'rgba')) {
    const alpha = rgbAlpha(token.args);
    if (alpha === null) return false;
    if (rejectTransparent && alpha === 0) return false;
    return true;
  }
  if (token.t === 'function' && (token.name === 'hsl' || token.name === 'hsla')) {
    const alpha = hslAlpha(token.args);
    if (alpha === null) return false;
    if (rejectTransparent && alpha === 0) return false;
    return true;
  }
  return false;
}

function hexAlpha(hex: string): number | null {
  if (!/^([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hex)) return null;
  if (hex.length === 3 || hex.length === 6) return 1;
  const pair = hex.length === 4 ? `${hex[3]}${hex[3]}` : hex.slice(6, 8);
  return Number.parseInt(pair, 16) / 255;
}

function rgbAlpha(args: CssToken[]): number | null {
  const parts = splitCommas(args);
  const channels =
    parts.length === 1
      ? args.filter((token) => token.t !== 'operator')
      : parts.map((part) => part[0]);
  if (channels.length !== 3 && channels.length !== 4) return null;
  if (parts.length > 1 && parts.length !== channels.length) return null;
  const colorChannels = channels.slice(0, 3);
  if (!colorChannels.every((token) => token && channelInRange(token))) return null;
  if (channels.length === 3) return 1;
  return alphaValue(channels[3]);
}

function hslAlpha(args: CssToken[]): number | null {
  if (args.length === 1 && isThemeColorVar(args[0])) return 1;
  if (
    args.length === 3 &&
    args[0] &&
    isThemeColorVar(args[0]) &&
    args[1]?.t === 'operator' &&
    args[1].v === '/' &&
    args[2]
  ) {
    return alphaValue(args[2]);
  }
  const parts = splitCommas(args);
  const values = parts.length >= 3 ? parts : [args.filter((token) => token.t !== 'operator')];
  const flat = parts.length >= 3 ? parts.map((part) => part[0]) : (values[0] ?? []);
  if (!flat || flat.length < 3 || flat.length > 4) return null;
  const hue = flat[0];
  const saturation = flat[1];
  const lightness = flat[2];
  if (!hue || !saturation || !lightness) return null;
  const hueNumber =
    hue.t === 'number'
      ? numeric(hue.v)
      : hue.t === 'dimension' && hue.u === 'deg'
        ? numeric(hue.v)
        : null;
  if (hueNumber === null || hueNumber < 0 || hueNumber > 360) return null;
  if (!isPercent(saturation, 0, 100) || !isPercent(lightness, 0, 100)) return null;
  if (flat.length === 3) return 1;
  return alphaValue(flat[3]);
}

function isThemeColorVar(token: CssToken | undefined): boolean {
  if (!token || token.t !== 'function' || token.name !== 'var' || token.args.length !== 1)
    return false;
  const name = token.args[0];
  return (
    name?.t === 'ident' && (TEXT_POSTPROCESS_THEME_COLOR_VARS as readonly string[]).includes(name.v)
  );
}

function channelInRange(token: CssToken | undefined): boolean {
  if (!token) return false;
  if (token.t === 'number') {
    const value = numeric(token.v);
    return value !== null && value >= 0 && value <= 255;
  }
  return isPercent(token, 0, 100);
}

function alphaValue(token: CssToken | undefined): number | null {
  if (!token) return null;
  if (token.t === 'number') {
    const value = numeric(token.v);
    if (value === null || value < 0 || value > 1) return null;
    return value;
  }
  if (token.t !== 'percentage' || !isPercent(token, 0, 100)) return null;
  return (numeric(token.v) ?? 0) / 100;
}

function checkFontFamily(tokens: CssToken[]): string | null {
  const parts = splitCommas(tokens);
  if (parts.length < 1 || parts.length > 6) return 'FORBIDDEN_VALUE';
  const ok = parts.every((part) => {
    if (part.length === 1 && part[0]?.t === 'string') {
      return safeFontString(part[0].v);
    }
    return part.every((token) => token.t === 'ident' && /^[a-zA-Z][a-zA-Z0-9-]*$/.test(token.v));
  });
  return ok ? null : 'FORBIDDEN_VALUE';
}

function safeFontString(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/url|[()\\]|[\n\r]/i.test(value);
}

function checkFontWeight(tokens: CssToken[]): string | null {
  if (tokens.length === 1 && tokens[0]?.t === 'ident') {
    return tokens[0].v === 'normal' || tokens[0].v === 'bold' ? null : 'FORBIDDEN_VALUE';
  }
  if (tokens.length === 1 && tokens[0]?.t === 'number') {
    const value = numeric(tokens[0].v);
    if (value !== null && value >= 100 && value <= 900 && value % 100 === 0) return null;
  }
  return 'FORBIDDEN_VALUE';
}

function checkLineHeight(tokens: CssToken[]): string | null {
  if (identOnly(tokens, ['normal']) === null) return null;
  if (tokens.length === 1 && tokens[0]?.t === 'number') {
    const value = numeric(tokens[0].v);
    if (value !== null && value >= 1 && value <= 2) return null;
  }
  return checkLengthRange(tokens, 12, 48, false);
}

function checkLetterSpacing(tokens: CssToken[]): string | null {
  if (identOnly(tokens, ['normal']) === null) return null;
  if (tokens.length !== 1) return 'FORBIDDEN_VALUE';
  const px = lengthPx(tokens[0]);
  if (px === null || px < -2 || px > 16) return 'FORBIDDEN_VALUE';
  return null;
}

function checkRadius(tokens: CssToken[]): string | null {
  if (tokens.length === 1 && isThemeRadius(tokens[0])) return null;
  if (tokens.some((token) => token.t === 'operator')) return 'FORBIDDEN_VALUE';
  return checkBoxEdges(tokens, 0, 32);
}

function isThemeRadius(token: CssToken | undefined): boolean {
  return (
    token?.t === 'function' &&
    token.name === 'var' &&
    token.args.length === 1 &&
    token.args[0]?.t === 'ident' &&
    token.args[0].v === TEXT_POSTPROCESS_THEME_RADIUS_VAR
  );
}

function checkBorder(tokens: CssToken[]): string | null {
  if (tokens.length < 1 || tokens.length > 3) return 'FORBIDDEN_VALUE';
  let sawWidth = false;
  let sawStyle = false;
  let sawColor = false;
  for (const token of tokens) {
    if (!sawWidth && lengthPx(token) !== null) {
      const px = lengthPx(token);
      if (px === null || px < 0 || px > 4) return 'FORBIDDEN_VALUE';
      sawWidth = true;
      continue;
    }
    if (
      !sawStyle &&
      token.t === 'ident' &&
      ['none', 'solid', 'dashed', 'dotted', 'double'].includes(token.v)
    ) {
      sawStyle = true;
      continue;
    }
    if (!sawColor && isColor([token], false)) {
      sawColor = true;
      continue;
    }
    return 'FORBIDDEN_VALUE';
  }
  return sawWidth || sawStyle || sawColor ? null : 'FORBIDDEN_VALUE';
}

function checkShadow(tokens: CssToken[]): string | null {
  const shadows = splitCommas(tokens);
  if (shadows.length < 1 || shadows.length > 2) return 'FORBIDDEN_VALUE';
  const ok = shadows.every((shadow) => {
    const parts = shadow.filter((token) => !(token.t === 'ident' && token.v === 'inset'));
    if (parts.length < 2 || parts.length > 5) return false;
    const lengths = parts.filter((token) => token.t === 'dimension' || token.t === 'number');
    const color = parts.find((token) => isColor([token], false));
    if (color && parts[parts.length - 1] !== color) return false;
    if (lengths.length < 2 || lengths.length > 4) return false;
    const offsetX = lengthPx(lengths[0]);
    const offsetY = lengthPx(lengths[1]);
    const blur = lengths[2] ? lengthPx(lengths[2]) : 0;
    const spread = lengths[3] ? lengthPx(lengths[3]) : 0;
    if (offsetX === null || offsetY === null || blur === null || spread === null) return false;
    return (
      offsetX >= -32 &&
      offsetX <= 32 &&
      offsetY >= -32 &&
      offsetY <= 32 &&
      blur >= 0 &&
      blur <= 32 &&
      spread >= 0 &&
      spread <= 8
    );
  });
  return ok ? null : 'FORBIDDEN_VALUE';
}

function checkBoxSize(tokens: CssToken[]): string | null {
  if (identOnly(tokens, ['auto']) === null) return null;
  if (tokens.length !== 1) return 'FORBIDDEN_VALUE';
  const token = tokens[0];
  if (token?.t === 'percentage') {
    const value = numeric(token.v);
    return value !== null && value >= 0 && value <= 100 ? null : 'FORBIDDEN_VALUE';
  }
  const px = lengthPx(token);
  return px !== null && px >= 0 && px <= 640 ? null : 'FORBIDDEN_VALUE';
}

function checkMargin(tokens: CssToken[]): string | null {
  const parts = splitSpaces(tokens);
  if (parts.length < 1 || parts.length > 4) return 'FORBIDDEN_VALUE';
  const ok = parts.every((part) => {
    if (part.length === 1 && part[0]?.t === 'ident' && part[0].v === 'auto') return true;
    if (part.length !== 1) return false;
    const px = lengthPx(part[0]);
    return px !== null && px >= 0 && px <= 32;
  });
  return ok ? null : 'FORBIDDEN_VALUE';
}

function checkBoxEdges(tokens: CssToken[], min: number, max: number): string | null {
  const parts = splitSpaces(tokens);
  if (parts.length < 1 || parts.length > 4) return 'FORBIDDEN_VALUE';
  const ok = parts.every((part) => part.length === 1 && inPx(part[0], min, max));
  return ok ? null : 'FORBIDDEN_VALUE';
}

function checkLengthRange(
  tokens: CssToken[],
  min: number,
  max: number,
  allowPercent: boolean
): string | null {
  if (tokens.length !== 1) return 'FORBIDDEN_VALUE';
  const token = tokens[0];
  if (allowPercent && token?.t === 'percentage') {
    const value = numeric(token.v);
    return value !== null && value >= min && value <= max ? null : 'FORBIDDEN_VALUE';
  }
  return inPx(token, min, max) ? null : 'FORBIDDEN_VALUE';
}

function checkFlex(tokens: CssToken[]): string | null {
  if (identOnly(tokens, ['none', 'auto']) === null) return null;
  if (tokens.length === 1 && tokens[0]?.t === 'number') return checkUnitless(tokens, 0, 4);
  if (tokens.length === 2 && tokens.every((token) => token.t === 'number')) {
    return tokens.every((token) => checkUnitless([token], 0, 4) === null)
      ? null
      : 'FORBIDDEN_VALUE';
  }
  if (tokens.length === 3 && tokens[0]?.t === 'number' && tokens[1]?.t === 'number') {
    if (checkUnitless([tokens[0]], 0, 4) !== null || checkUnitless([tokens[1]], 0, 4) !== null) {
      return 'FORBIDDEN_VALUE';
    }
    return checkBasis([tokens[2] as CssToken]);
  }
  return 'FORBIDDEN_VALUE';
}

function checkBasis(tokens: CssToken[]): string | null {
  if (identOnly(tokens, ['auto']) === null) return null;
  if (tokens.length === 1 && tokens[0]?.t === 'number' && numeric(tokens[0].v) === 0) return null;
  return checkBoxSize(tokens);
}

function checkUnitless(tokens: CssToken[], min: number, max: number): string | null {
  if (tokens.length !== 1 || tokens[0]?.t !== 'number') return 'FORBIDDEN_VALUE';
  const value = numeric(tokens[0].v);
  return value !== null && value >= min && value <= max ? null : 'FORBIDDEN_VALUE';
}

function checkGridColumns(tokens: CssToken[]): string | null {
  if (
    tokens.length === 1 &&
    tokens[0]?.t === 'function' &&
    tokens[0].name === 'repeat' &&
    checkRepeat(tokens[0].args)
  ) {
    return null;
  }
  const tracks = splitSpaces(tokens);
  if (tracks.length < 1 || tracks.length > 4) return 'FORBIDDEN_VALUE';
  return tracks.every((track) => checkTrack(track)) ? null : 'FORBIDDEN_VALUE';
}

function checkRepeat(args: CssToken[]): boolean {
  const comma = args.findIndex((token) => token.t === 'operator' && token.v === ',');
  if (comma !== 1) return false;
  const count = args[0];
  if (count?.t !== 'number') return false;
  const value = numeric(count.v);
  if (value === null || value < 1 || value > 6 || !Number.isInteger(value)) return false;
  return checkTrack(args.slice(comma + 1));
}

function checkTrack(tokens: CssToken[]): boolean {
  if (tokens.length === 1 && tokens[0]?.t === 'dimension' && tokens[0].u === 'fr') {
    return numeric(tokens[0].v) === 1;
  }
  if (tokens.length === 1 && checkBoxSize(tokens) === null) return true;
  if (tokens.length === 1 && tokens[0]?.t === 'function' && tokens[0].name === 'minmax') {
    const comma = tokens[0].args.findIndex((token) => token.t === 'operator' && token.v === ',');
    if (comma < 1) return false;
    const min = tokens[0].args.slice(0, comma);
    const max = tokens[0].args.slice(comma + 1);
    const minOk =
      (min.length === 1 && min[0]?.t === 'number' && numeric(min[0].v) === 0) ||
      checkBoxSize(min) === null;
    return minOk && checkTrack(max);
  }
  return false;
}

function checkPlaceItems(tokens: CssToken[]): string | null {
  const allowed = ['start', 'end', 'center', 'stretch', 'normal'];
  if (tokens.length === 1) return identOnly(tokens, allowed);
  if (tokens.length === 2) {
    return identOnly([tokens[0] as CssToken], allowed) === null &&
      identOnly([tokens[1] as CssToken], allowed) === null
      ? null
      : 'FORBIDDEN_VALUE';
  }
  return 'FORBIDDEN_VALUE';
}

function checkListStyle(tokens: CssToken[]): string | null {
  const allowed = ['none', 'disc', 'decimal', 'inside', 'outside'];
  if (tokens.length < 1 || tokens.length > 3) return 'FORBIDDEN_VALUE';
  return tokens.every((token) => token.t === 'ident' && allowed.includes(token.v))
    ? null
    : 'FORBIDDEN_VALUE';
}

function checkTimeList(tokens: CssToken[]): string | null {
  const parts = splitCommas(tokens);
  if (parts.length < 1 || parts.length > 5) return 'FORBIDDEN_VALUE';
  let total = 0;
  for (const part of parts) {
    const ms = timeMs(part);
    if (ms === null || ms < 0) return 'FORBIDDEN_VALUE';
    total += ms;
  }
  return total <= 300 ? null : 'FORBIDDEN_VALUE';
}

function timeMs(tokens: CssToken[]): number | null {
  if (tokens.length !== 1) return null;
  const token = tokens[0];
  if (!token || token.t !== 'dimension') return null;
  const value = numeric(token.v);
  if (value === null) return null;
  if (token.u === 'ms') return value;
  if (token.u === 's') return value * 1000;
  return null;
}

function identOnly(tokens: CssToken[], allowed: readonly string[]): string | null {
  if (tokens.length !== 1 || tokens[0]?.t !== 'ident' || !allowed.includes(tokens[0].v)) {
    return 'FORBIDDEN_VALUE';
  }
  return null;
}

function everyPart(
  parts: CssToken[][],
  check: (part: CssToken[]) => boolean,
  min: number,
  max: number
): string | null {
  if (parts.length < min || parts.length > max) return 'FORBIDDEN_VALUE';
  return parts.every((part) => check(part)) ? null : 'FORBIDDEN_VALUE';
}

function splitCommas(tokens: CssToken[]): CssToken[][] {
  const parts: CssToken[][] = [[]];
  for (const token of tokens) {
    if (token.t === 'operator' && token.v === ',') parts.push([]);
    else parts[parts.length - 1]?.push(token);
  }
  return parts.filter((part) => part.length > 0);
}

function splitSpaces(tokens: CssToken[]): CssToken[][] {
  return tokens.filter((token) => token.t !== 'operator').map((token) => [token]);
}

function inPx(token: CssToken | undefined, min: number, max: number): boolean {
  const px = lengthPx(token);
  return px !== null && px >= min && px <= max;
}

function lengthPx(token: CssToken | undefined): number | null {
  if (!token) return null;
  if (token.t === 'number') {
    return numeric(token.v) === 0 ? 0 : null;
  }
  if (token.t !== 'dimension') return null;
  const value = numeric(token.v);
  if (value === null) return null;
  if (token.u === 'px') return value;
  if (token.u === 'rem' || token.u === 'em') return value * ROOT_PX;
  return null;
}

function isPercent(token: CssToken | undefined, min: number, max: number): boolean {
  if (!token || token.t !== 'percentage') return false;
  const value = numeric(token.v);
  return value !== null && value >= min && value <= max;
}

function numeric(raw: string): number | null {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function isHtmlTag(value: string): value is TextPostprocessHtmlTag {
  return (TEXT_POSTPROCESS_HTML_TAGS as readonly string[]).includes(value);
}

export function scopeProbeSelector(selector: CssSelector): string {
  return `.tp-scope ${serializeSelector(selector)}`;
}

export function serializeScopedCss(rules: CssRule[], scopeClass: string): string {
  if (!TEXT_POSTPROCESS_CLASS_TOKEN.test(scopeClass)) {
    throw new Error('Invalid text postprocess scope class.');
  }
  return rules.map((rule) => serializeRule(rule, scopeClass)).join('\n');
}

function serializeRule(rule: CssRule, scopeClass: string): string {
  if (rule.type === 'media') {
    const condition = rule.conditions
      .map((item) =>
        item.type === 'width'
          ? `(${item.feature}: ${item.px}px)`
          : `(prefers-color-scheme: ${item.scheme})`
      )
      .join(' and ');
    const body = rule.rules.map((style) => serializeRule(style, scopeClass)).join('\n');
    return `@media ${condition} {\n${body}\n}`;
  }
  const selectors = rule.selectors
    .map((selector) => `.${scopeClass} ${serializeSelector(selector)}`)
    .join(', ');
  const declarations = rule.declarations
    .map((declaration) => `${declaration.property}: ${serializeTokens(declaration.tokens)};`)
    .join(' ');
  return `${selectors} { ${declarations} }`;
}

function serializeSelector(selector: CssSelector): string {
  return selector.compounds
    .map((compound, index) => {
      const prefix = index === 0 ? '' : compound.combinator === 'child' ? ' > ' : ' ';
      const tag = compound.tag ?? '';
      const classes = compound.classes.map((token) => `.${token}`).join('');
      const pseudos = compound.pseudos
        .map((pseudo) =>
          pseudo.kind === 'nth-child'
            ? `:nth-child(${formatNth(pseudo.a, pseudo.b)})`
            : `:${pseudo.kind}`
        )
        .join('');
      return `${prefix}${tag}${classes}${pseudos}`;
    })
    .join('');
}

function formatNth(a: number | null, b: number): string {
  if (a === null) return String(b);
  if (b === 0) return `${a}n`;
  if (b > 0) return `${a}n+${b}`;
  return `${a}n${b}`;
}

function serializeTokens(tokens: CssToken[]): string {
  return tokens
    .map((token, index) => {
      const text = serializeToken(token);
      const previous = tokens[index - 1];
      if (index === 0 || token.t === 'operator' || previous?.t === 'operator') return text;
      return ` ${text}`;
    })
    .join('');
}

function serializeToken(token: CssToken): string {
  switch (token.t) {
    case 'ident':
      return token.v;
    case 'hash':
      return `#${token.v}`;
    case 'string':
      return `"${token.v.replace(/"/g, '\\"')}"`;
    case 'number':
      return token.v;
    case 'dimension':
      return `${token.v}${token.u}`;
    case 'percentage':
      return `${token.v}%`;
    case 'operator':
      return token.v === ',' ? ', ' : ' / ';
    case 'function':
      return `${token.name}(${serializeTokens(token.args)})`;
    default:
      return '';
  }
}
