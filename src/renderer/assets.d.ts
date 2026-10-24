// Dichiarazioni ambientali degli asset Vite (file senza import: modulo globale ambient).
declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*.css' {
  const css: string;
  export default css;
}

declare module '*?raw' {
  const text: string;
  export default text;
}
