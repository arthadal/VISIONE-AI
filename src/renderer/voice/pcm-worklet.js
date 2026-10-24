// AudioWorklet del microfono (Fase 9): accumula i campioni in blocchi e li passa al thread
// principale. Nessuna logica: il PCM va al processo voce attraverso la porta dedicata.
class VisionePcmForwarder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(1024);
    this.fill = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // Guardia (P-74): un canale dal conteggio non finito non deve entrare nel ciclo di copia.
    if (!channel || !Number.isFinite(channel.length) || channel.length <= 0) return true;
    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.fill] = channel[i];
      this.fill += 1;
      if (this.fill === this.buffer.length) {
        this.port.postMessage(this.buffer.slice(0));
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('visione-pcm', VisionePcmForwarder);
