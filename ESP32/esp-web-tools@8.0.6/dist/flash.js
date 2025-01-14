import { ESPLoader } from "esp-web-flasher";
import { getChipFamilyName } from "./util/chip-family-name";
import { sleep } from "./util/sleep";
export const flash = async (onEvent, port, logger, manifestPath, eraseFirst) => {
    let manifest;
    let build;
    let chipFamily;
    const fireStateEvent = (stateUpdate) => onEvent({
        ...stateUpdate,
        manifest,
        build,
        chipFamily,
    });
    const manifestURL = new URL(manifestPath, location.toString()).toString();
    const manifestProm = fetch(manifestURL).then((resp) => resp.json());
    const esploader = new ESPLoader(port, logger);
    // For debugging
    window.esploader = esploader;
    fireStateEvent({
        state: "initializing" /* FlashStateType.INITIALIZING */,
        message: "Iniciando...",
        details: { done: false },
    });
    try {
        await esploader.initialize();
    }
    catch (err) {
        logger.error(err);
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: "No se pudo iniciar. Intente restablecer su dispositivo o mantenga presionado el botón ARRANQUE mientras hace clic en INSTALAR.",
            details: { error: "failed_initialize" /* FlashError.FAILED_INITIALIZING */, details: err },
        });
        if (esploader.connected) {
            await esploader.disconnect();
        }
        return;
    }
    chipFamily = getChipFamilyName(esploader);
    fireStateEvent({
        state: "initializing" /* FlashStateType.INITIALIZING */,
        message: `Inicializado. Encontró ${chipFamily}`,
        details: { done: true },
    });
    fireStateEvent({
        state: "manifest" /* FlashStateType.MANIFEST */,
        message: "Obteniendo manifiesto...",
        details: { done: false },
    });
    try {
        manifest = await manifestProm;
    }
    catch (err) {
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: `No se puede recuperar el manifiesto: ${err}`,
            details: { error: "fetch_manifest_failed" /* FlashError.FAILED_MANIFEST_FETCH */, details: err },
        });
        await esploader.disconnect();
        return;
    }
    build = manifest.builds.find((b) => b.chipFamily === chipFamily);
    fireStateEvent({
        state: "manifest" /* FlashStateType.MANIFEST */,
        message: `Encontrado manifiesto para ${manifest.name}`,
        details: { done: true },
    });
    if (!build) {
        fireStateEvent({
            state: "error" /* FlashStateType.ERROR */,
            message: `Su dispositivo ${chipFamily} no está soportado.`,
            details: { error: "not_supported" /* FlashError.NOT_SUPPORTED */, details: chipFamily },
        });
        await esploader.disconnect();
        return;
    }
    fireStateEvent({
        state: "preparing" /* FlashStateType.PREPARING */,
        message: "Preparando la instalación...",
        details: { done: false },
    });
    const filePromises = build.parts.map(async (part) => {
        const url = new URL(part.path, manifestURL).toString();
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`Downlading firmware ${part.path} failed: ${resp.status}`);
        }
        return resp.arrayBuffer();
    });
    // Run the stub while we wait for files to download
    const espStub = await esploader.runStub();
    const files = [];
    let totalSize = 0;
    for (const prom of filePromises) {
        try {
            const data = await prom;
            files.push(data);
            totalSize += data.byteLength;
        }
        catch (err) {
            fireStateEvent({
                state: "error" /* FlashStateType.ERROR */,
                message: err.message,
                details: {
                    error: "failed_firmware_download" /* FlashError.FAILED_FIRMWARE_DOWNLOAD */,
                    details: err.message,
                },
            });
            await esploader.disconnect();
            return;
        }
    }
    fireStateEvent({
        state: "preparing" /* FlashStateType.PREPARING */,
        message: "Instalación preparada",
        details: { done: true },
    });
    if (eraseFirst) {
        fireStateEvent({
            state: "erasing" /* FlashStateType.ERASING */,
            message: "Limpiando dispositivo...",
            details: { done: false },
        });
        await espStub.eraseFlash();
        fireStateEvent({
            state: "erasing" /* FlashStateType.ERASING */,
            message: "Dispositivo limpiado",
            details: { done: true },
        });
    }
    let lastPct = 0;
    fireStateEvent({
        state: "writing" /* FlashStateType.WRITING */,
        message: `Progreso de instalación: ${lastPct}%`,
        details: {
            bytesTotal: totalSize,
            bytesWritten: 0,
            percentage: lastPct,
        },
    });
    let totalWritten = 0;
    for (const part of build.parts) {
        const file = files.shift();
        try {
            await espStub.flashData(file, (bytesWritten) => {
                const newPct = Math.floor(((totalWritten + bytesWritten) / totalSize) * 100);
                if (newPct === lastPct) {
                    return;
                }
                lastPct = newPct;
                fireStateEvent({
                    state: "writing" /* FlashStateType.WRITING */,
                    message: `Progreso de instalación: ${newPct}%`,
                    details: {
                        bytesTotal: totalSize,
                        bytesWritten: totalWritten + bytesWritten,
                        percentage: newPct,
                    },
                });
            }, part.offset, true);
        }
        catch (err) {
            fireStateEvent({
                state: "error" /* FlashStateType.ERROR */,
                message: err.message,
                details: { error: "write_failed" /* FlashError.WRITE_FAILED */, details: err },
            });
            await esploader.disconnect();
            return;
        }
        totalWritten += file.byteLength;
    }
    fireStateEvent({
        state: "writing" /* FlashStateType.WRITING */,
        message: "instalación completada",
        details: {
            bytesTotal: totalSize,
            bytesWritten: totalWritten,
            percentage: 100,
        },
    });
    await sleep(100);
    console.log("DISCONNECT");
    await esploader.disconnect();
    console.log("HARD RESET");
    await esploader.hardReset();
    fireStateEvent({
        state: "finished" /* FlashStateType.FINISHED */,
        message: "¡Todo listo!",
    });
};
