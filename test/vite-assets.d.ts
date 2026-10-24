// Dichiarazioni per i moduli Vite importati indirettamente dai test del renderer (`?url`).
// Il programma node di tsc include `test/**` ma non le dichiarazioni del renderer: qui bastano
// quelle usate dal codice sotto test.
declare module '*?url' {
  const url: string;
  export default url;
}
