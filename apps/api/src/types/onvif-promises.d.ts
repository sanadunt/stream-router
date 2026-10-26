// Spesifier memakai index.js eksplisit: onvif@0.8 tidak memiliki peta "exports", dan Node ESM
// (dist production) menolak import direktori 'onvif/promises' dengan ERR_UNSUPPORTED_DIR_IMPORT.
declare module 'onvif/promises/index.js' {
  interface LegacyUrl {
    href?: string;
    protocol?: string;
    hostname?: string;
    port?: string;
    pathname?: string;
  }

  export interface CamOptions {
    hostname: string;
    port?: number;
    username?: string;
    password?: string;
    useSecure?: boolean;
    path?: string;
    timeout?: number;
    preserveAddress?: boolean;
    urn?: string;
  }

  export class Cam {
    constructor(options: CamOptions);
    hostname?: string;
    port?: number;
    path?: string;
    urn?: string;
    xaddrs?: LegacyUrl[];
    profiles?: Array<{
      $?: { token?: string };
      name?: string;
      videoEncoderConfiguration?: {
        encoding?: string;
        resolution?: { width?: number; height?: number };
      };
      PTZConfiguration?: {
        defaultContinuousZoomVelocitySpace?: string;
        defaultPTZSpeed?: { zoom?: { x?: number } };
      };
    }>;
    connect(): Promise<unknown>;
    // Nilai teks numerik dari kamera dikembalikan library sebagai number.
    getDeviceInformation(): Promise<{
      manufacturer?: unknown;
      model?: unknown;
      firmwareVersion?: unknown;
      serialNumber?: unknown;
      hardwareId?: unknown;
    } | undefined>;
    getHostname(): Promise<{ fromDHCP?: unknown; name?: unknown } | null | undefined>;
    getStreamUri(options: {
      stream?: string;
      protocol?: string;
      profileToken?: string;
    }): Promise<{ uri?: string }>;
    continuousMove(options: {
      profileToken?: string;
      x?: number;
      y?: number;
      zoom?: number;
      timeout?: number;
      onlySendPanTilt?: boolean;
      onlySendZoom?: boolean;
    }): Promise<unknown>;
    stop(options?: { profileToken?: string; panTilt?: boolean; zoom?: boolean }): Promise<unknown>;
  }

  export const Discovery: {
    on(event: 'device', listener: (cam: Cam, remote: { address?: string }, xml?: string) => void): void;
    off(event: 'device', listener: (cam: Cam, remote: { address?: string }, xml?: string) => void): void;
    probe(
      options: { timeout?: number; resolve?: boolean; device?: string },
      callback: (error: unknown, cameras: Cam[]) => void
    ): void;
  };

  const onvifPromises: {
    Cam: typeof Cam;
    Discovery: typeof Discovery;
  };
  export default onvifPromises;
}
