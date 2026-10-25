# FreeAPC64 `v0.0.1` — Custom Firmware Universal DAW & Web Project / Synth Editor

**FreeAPC64** es un ecosistema abierto para el controlador **Akai Professional APC64** que incluye:

1. **Custom Firmware Liberado (`firmware/freeapc64-custom-1.2.1.6.rbin`)**: Desbloquea el APC64 para funcionar de forma nativa y completa en **cualquier DAW (Bitwig Studio, Reaper, Ardour, FL Studio, Logic Pro, Studio One, etc.)** o sintetizador hardware/software por USB, MIDI DIN y CV/Gate, sin depender de Ableton Live.
2. **Respaldo Oficial de Fábrica (`firmware/akai-apc64-stock-1.2.1.6.rbin`)**: Imagen original íntegra (`v1.2.1.6` + Bootloader `v1.2.0.7`) verificada por CRC32 para restaurar el controlador a su estado original en cualquier momento.
3. **Instalador de Firmware Multiplataforma (`scripts/install-firmware.js` y `scripts/install-firmware.py`)**: Herramienta CLI y GUI Web compatible con **Linux, macOS y Windows** que implementa el protocolo de bootloader Rane/inMusic (`F0 00 00 17 70/71/73/79 F7`).
4. **Editor Web de Proyectos y Parámetros de Sintetizador en Node.js (`src/server.js` + `public/`)**: Transforma el `APC64 Project Editor 1.0.8` de escritorio en una aplicación web moderna con **WebMIDI**, **Sintetizador Polifónico WebAudio integrado**, **Simulador y Escritor de Pantalla OLED (`SysEx 0x10/0x1A`)**, **Rack de Parámetros MIDI CC de Sintetizador**, **Editor de 64 Pads RGB y 8 Touchstrips**, **Secuenciador Standalone de 8 Pistas** y **Ajustes Globales / 8 CV-Gate (`SysEx 0x18`)**.

---

## ¿Qué libera el Custom Firmware `FreeAPC64 1.2.1.6`?

En el firmware original de fábrica (`1.2.1.6`), el microcontrolador **NXP i.MX RT10xx (ARM Cortex-M7 Thumb-2, Flash XIP en `0x60095000`)** impone varias restricciones cuando no recibe el handshake propietario de Ableton Live (`SysEx 0x1B`):

| Dirección Flash | Parche | Problema en Firmware Original | Solución en `FreeAPC64 v0.0.1` |
| :--- | :--- | :--- | :--- |
| `0x600b0bbe` | `unlock_session_view_popup` | `UI::switchPage` redirige la vista `CPageSession` (`r4+0x468`) a la pantalla de bloqueo `CPageLivePopUp` (*"Please connect to Ableton Live"*), apagando los 64 pads. | Se neutraliza la redirección (`nop; nop; nop`). La matriz de 64 pads, lanzamiento de escenas y pistas funcionan inmediatamente en **Bitwig, Reaper o cualquier DAW**. |
| `0x600b1206` | `disable_live_disconnect_redirect` | El manejador del parámetro `0xC8` (`isLiveDisconnected`) fuerza el salto a `CPageLivePopUp`. | Se elimina la llamada forzada a `CPageLivePopUp`, manteniendo activa la superficie de control. |
| `0x600b10c0` | `redirect_page_index_5_to_session` | El índice de página `5` en `UI::switchPageByIndex` abre el popup de bloqueo. | Se redirige el índice `5` directamente a `CPageSession` (`r0+0x468`). |
| `0x600b0b94` / `0x600b0b9c` | `unlock_device_mixer_pages` | Bloquea el acceso a las páginas `Device` (`r0+0x200`) y `Mixer` (`r0+0x334`) cuando el dispositivo está en modo Standalone. | Se desbloquean ambas páginas en todos los modos de operación. |
| `0x600b1ac0` | `unlock_fader_midi_cc_all_modes` | En modo DAW, mover cualquiera de los **8 Touchstrip Faders** solo llama a `0x600b2e60` (PitchBend DAW) y **omite `0x600ada00`**, impidiendo usar los faders para enviar MIDI CC a sintetizadores o DAWs. | Se reestructura la rutina de faders para ejecutar **ambas funciones (`0x600b2e60` y `0x600ada00`)**, transmitiendo **MIDI CC1, CC2 y Notas de Fader** por USB, MIDI DIN y CV en todos los modos. |
| `0x600bcfa6` | `unlock_sysex_mode_switch` | Ignora el comando `SysEx 0x19` (cambio de modo UI) si el dispositivo está en modo Standalone. | Permite cambiar la página activa del hardware por `SysEx 0x19` desde el Editor Web o scripts de DAW en cualquier modo. |
| `0x600e90bc` / `0x600d8abe` | `oled_label_universal_daw` | Muestra *"Ableton Live"* y *"Please connect to Ableton Live"* en la pantalla OLED. | Actualiza las etiquetas OLED a **`Universal DAW`** y **`FreeAPC64 v0.1`**. |

### Checksums IEEE 802.3 CRC32 Verificados (`.rbin`)

- **Región 0 (Secondary Bootloader `v1.2.0.7` @ `0x6007d000`)**: `0x1dbfe002` (Intacto por seguridad de arranque).
- **Región 1 Stock (`v1.2.1.6` @ `0x60095000`)**: Span `0x7b044025` (`Seg 0 = 0x6cefa87a`, `Seg 1 = 0xb42098a8`).
- **Región 1 Custom (`FreeAPC64 v1.2.1.6` @ `0x60095000`)**: Span `0x5d2108fc` (`Seg 0 = 0x6cefa87a`, `Seg 1 = 0x9205d071`).

---

## Requisitos Previos

- **Node.js** `>= 18.0.0` (probado hasta Node `v26.x`).
- **Python 3** `>= 3.8` (para el constructor de firmware y transporte CLI multiplataforma).
- Navegador compatible con **WebMIDI** (Google Chrome, Chromium, Microsoft Edge, Brave u Opera) si deseas sincronizar proyectos y flashear directamente desde la interfaz web.

---

## Paso a Paso: Cómo Instalar el Custom Firmware (`FreeAPC64 1.2.1.6`)

El instalador es **100% multiplataforma** (funciona en **Linux, macOS y Windows**).

### Paso 1: Verificar la integridad de los archivos de firmware

Antes de flashear, ejecuta el verificador criptográfico y de checksums CRC32:

```bash
npm run verify
```

Verás la confirmación `[OK]` tanto del firmware original (`0x7b044025`) como del custom firmware (`0x5d2108fc`) y las 6 baterías de pruebas automatizadas.

### Paso 2: Conectar el Akai APC64 por USB

1. Conecta tu **APC64** directamente a un puerto USB de tu ordenador (evita hubs USB sin alimentación durante la actualización de firmware).
2. Enciende el APC64 normalmente.
3. Cierra cualquier DAW abierto para liberar los puertos USB MIDI del controlador.

### Paso 3 (Opción A — Recomendado): Instalar desde la Interfaz Web (Node.js + WebMIDI)

1. Inicia el servidor de **FreeAPC64**:
   ```bash
   npm start
   ```
2. Abre en Chrome, Brave o Edge la dirección:
   ```text
   http://localhost:3000
   ```
3. Haz clic arriba en **"Conectar WebMIDI"** y acepta el permiso de control **SysEx** del navegador.
4. Ve a la pestaña **"5. Instalador Custom Firmware & Restauración Original"**.
5. Haz clic en **"Instalar Custom Firmware (WebMIDI / Simulador)"**.
6. El instalador ejecutará automáticamente las 6 etapas del protocolo RBIN (`F0 00 00 17 70/71` Inquiry -> `0x79` Handshake de 3 pasos a Bootloader -> `0x73` Erase `0xC5` -> Write Chunks `0xC7`/`0xC6` -> Validate CRC32 `0xC8` -> Reboot `0xC1`).
7. Al finalizar (100%), el APC64 se reiniciará automáticamente con **FreeAPC64 v0.0.1** activo.

### Paso 3 (Opción B): Instalar desde la Terminal (CLI Multiplataforma en Linux, macOS o Windows)

Puedes ejecutar el instalador directamente por línea de comandos:

```bash
# Usando npm (Linux / macOS / Windows):
npm run flash:custom

# O directamente con Python 3:
python3 scripts/install-firmware.py --custom
```

> **Nota para probar en modo simulación sin hardware conectado**:
> ```bash
> npm run flash:dry-run
> # o:
> python3 scripts/install-firmware.py --custom --dry-run
> ```

---

## Paso a Paso: Cómo Volver al Firmware Original de Fábrica (`Stock 1.2.1.6`)

El repositorio incluye una copia exacta byte por byte del firmware oficial de Akai Professional en `firmware/akai-apc64-stock-1.2.1.6.rbin` (SHA-256: `0b5a4d7c1fc1ee731e72bb0fd54ff214315e2a4180bb0b97bc66fc099d2beec1`).

### Método 1: Desde el Editor Web (`http://localhost:3000`)

1. Ejecuta `npm start` y abre `http://localhost:3000`.
2. Ve a la pestaña **"5. Instalador Custom Firmware & Restauración Original"**.
3. Haz clic en el botón naranja **"Restaurar Firmware Original (Stock 1.2.1.6)"**.
4. Espera a que la barra llegue al 100%; el controlador volverá exactamente al firmware de fábrica `1.2.1.6`.

### Método 2: Desde la Terminal (Linux, macOS o Windows)

Ejecuta cualquiera de los siguientes comandos con el APC64 conectado por USB:

```bash
npm run flash:stock
# o directamente:
python3 scripts/install-firmware.py --stock
```

### Método 3: Recuperación desde el Modo Bootloader (Safe Recovery)

Como el **Bootloader Secundario (`Region 0`, `v1.2.0.7` en `0x60008000` / `0x6007d000`)** no se modifica y cuenta con validación CRC32 antes de saltar a la aplicación (`0x60095000`), el APC64 es resistente a desconexiones accidentales:
- Si el cable USB se desconecta a mitad de una actualización, al volver a encender el APC64 este permanecerá automáticamente en **Modo Bootloader** (`info[24] == 1`).
- Simplemente vuelve a ejecutar `npm run flash:stock` (o `npm run flash:custom`); el instalador detectará que el dispositivo ya está en modo Bootloader (`[4/6] Device is already in Bootloader mode`) y escribirá el firmware completo.

---

## Cómo Usar el Editor Web de Proyectos y Parámetros de Sintetizador

Inicia el servidor con:

```bash
npm start
```

Y abre `http://localhost:3000`:

1. **Superficie APC64 (64 Pads RGB & 8 Touchstrips CC)**:
   - Haz clic en cualquiera de los **64 Pads RGB** para tocar notas en tiempo real (con el sintetizador polifónico WebAudio integrado y salida USB MIDI simultánea) y editar su **Nota, Octava, Canal MIDI (1–16), Poly Aftertouch, Ruteo (USB / MIDI DIN / CV)** y **Colores RGB en Reposo (Off) y Pulsado (On)**.
   - Usa el **Generador de Escalas Isométricas** para mapear los 64 pads instantáneamente en cualquier tonalidad y escala (*Menor Natural, Mayor, Dórica, Frigia, Lidia, Mixolidia, Menor Armónica, Pentatónica o Cromática*).
   - Arrastra o selecciona cualquiera de los **8 Touchstrip Faders** para transmitir **MIDI CC1 y CC2** en tiempo real y configurar su etiqueta, modo (`Single CC` o `Dual CC`), números de CC (`0–127`), canal MIDI, estilo de barra LED (`Volumen Fill` o `Paneo Bipolar`) y colores RGB.
   - Escribe mensajes personalizados en las líneas de la **Pantalla OLED del APC64** (`SysEx 0x10 / 0x1A`) o cambia el modo físico del hardware (`Session`, `Device`, `Mixer`, `Custom`, `Note`, `Chord`, `Step Seq`) con un clic (`SysEx 0x19`).
2. **Sintetizador & Rack de Parámetros MIDI CC**:
   - Controla 16 parámetros de sintetizador listos para cualquier VST o sinte hardware: **Filter Cutoff (CC74), Resonance (CC71), Attack (CC73), Decay (CC75), Sustain (CC79), Release (CC72), LFO Rate (CC76), ModWheel (CC1), Glide (CC5), Expression (CC11), Chorus (CC93), Reverb (CC91)**, además de controles dedicados para **Bitwig (CC20–27)** y **Reaper (CC16–23)**.
3. **Step Sequencer & 8 Pistas Standalone**:
   - Configura las 8 pistas internas del secuenciador por pasos (Tipo Melódica/Drum, Canal MIDI, División de Tiempo `1/4`..`1/32T`, Gate Length, Swing, Velocidad y salidas USB/DIN/CV).
4. **Ajustes Globales & 8 Salidas CV/Gate (`SysEx 0x18`)**:
   - Configura el Modo de Dispositivo (`Universal DAW` vs `Standalone`), Reloj MIDI, Brillo de LEDs, Curva de Sensibilidad de Pads, las **8 salidas CV/Gate** y las **16 notas globales de Drum Pads**.

---

## Integración con Bitwig Studio y Reaper

### Configurar en Bitwig Studio

1. Copia el script incluido en este repositorio a la carpeta de scripts de controlador de Bitwig:
   - **Linux**: `cp daw-scripts/bitwig/FreeAPC64.control.js ~/Bitwig\ Studio/Controller\ Scripts/`
   - **macOS**: `cp daw-scripts/bitwig/FreeAPC64.control.js ~/Documents/Bitwig\ Studio/Controller\ Scripts/`
   - **Windows**: Copia `daw-scripts/bitwig/FreeAPC64.control.js` a `%USERPROFILE%\Documents\Bitwig Studio\Controller Scripts\`
2. En Bitwig Studio, abre **Settings -> Controllers -> Add Controller -> Akai Professional (FreeAPC64)**.
3. Asigna los puertos de entrada/salida **`DAW (APC64)`** y **`Custom (APC64)`**.
4. En el Editor Web (`http://localhost:3000`), selecciona la plantilla **"Bitwig Studio (8 Remotes + Grid)"** y haz clic en **"Enviar a APC64 (SysEx)"**.

### Configurar en Reaper

1. En Reaper, abre **Options -> Preferences -> Audio -> MIDI Devices** y habilita como entrada y salida (incluyendo *Control*):
   - `DAW (APC64)` / `APC64 MIDI 1`
   - `Notes (APC64)` / `APC64 MIDI 2`
   - `Custom (APC64)` / `APC64 MIDI 4`
2. Opcionalmente, carga el script Lua incluido desde **Actions -> Show action list -> New Action -> Load ReaScript...** seleccionando `daw-scripts/reaper/FreeAPC64_Reaper.lua`.
3. En el Editor Web (`http://localhost:3000`), selecciona la plantilla **"Reaper DAW (Mixer + ReaFX CC)"** y haz clic en **"Enviar a APC64 (SysEx)"**. Todos los pads y los 8 touchstrips responderán de inmediato a **MIDI Learn** y **ReaLearn** en cualquier pista o sintetizador VST.

---

## Estructura del Proyecto

```text
FreeAPC64/
├── firmware/
│   ├── akai-apc64-stock-1.2.1.6.rbin     # Firmware original de fábrica (v1.2.1.6)
│   ├── freeapc64-custom-1.2.1.6.rbin     # Custom Firmware liberado (Universal DAW + CC)
│   └── patch-manifest.json               # Manifiesto de parches ARM Thumb-2 y CRC32
├── scripts/
│   ├── build-firmware.py                 # Constructor y validador de imagen .rbin
│   ├── install-firmware.js               # Instalador CLI multiplataforma (Node.js)
│   └── install-firmware.py               # Motor de flasheo RBIN multiplataforma (Python)
├── src/
│   ├── apc64-protocol.js                 # Codificador/Decodificador 7-bit SysEx y !Rbn
│   ├── presets.js                        # Plantillas para Bitwig, Reaper y Sintetizadores
│   ├── server.js                         # Servidor Web Node.js + API REST SysEx
│   └── test-suite.js                     # Suite de pruebas automatizadas
├── public/
│   ├── index.html                        # Interfaz del Editor Web y Actualizador
│   ├── styles.css                        # Estilos hardware oscuro y animaciones RGB
│   ├── app.js                            # Motor WebMIDI, Sintetizador WebAudio y UI
│   ├── assets/                           # Gráficos y logotipos extraídos del APC64
│   └── fonts/                            # Tipografía oficial Akai DIN
├── daw-scripts/
│   ├── bitwig/FreeAPC64.control.js       # Control Surface Script para Bitwig Studio
│   └── reaper/FreeAPC64_Reaper.lua       # ReaScript para Reaper DAW
└── presets/                              # Proyectos preconfigurados (.apc64.json)
```
