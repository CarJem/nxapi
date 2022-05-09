import createDebug from 'debug';
import * as persist from 'node-persist';
import { FlapgApiResponse } from '../../api/f.js';
import { NintendoAccountSessionTokenJwtPayload, NintendoAccountToken, NintendoAccountUser } from '../../api/na.js';
import { Jwt } from '../../api/util.js';
import { AccountLogin } from '../../api/znc-types.js';
import ZncApi, { ZNCA_CLIENT_ID } from '../../api/znc.js';
import ZncProxyApi from '../../api/znc-proxy.js';

const debug = createDebug('cli:nso');

export interface SavedToken {
    uuid: string;
    timestamp: string;
    nintendoAccountToken: NintendoAccountToken;
    user: NintendoAccountUser;
    flapg: FlapgApiResponse['result'];
    nsoAccount: AccountLogin;
    credential: AccountLogin['webApiServerCredential'];

    expires_at: number;
    proxy_url?: string;
}

export async function getToken(storage: persist.LocalStorage, token: string, proxy_url: string): Promise<{
    nso: ZncProxyApi;
    data: SavedToken;
}>
export async function getToken(storage: persist.LocalStorage, token: string, proxy_url?: string): Promise<{
    nso: ZncApi;
    data: SavedToken;
}>
export async function getToken(storage: persist.LocalStorage, token: string, proxy_url?: string) {
    if (!token) {
        console.error('No token set. Set a Nintendo Account session token using the `--token` option or by running `nxapi nso token`.');
        throw new Error('Invalid token');
    }

    const [jwt, sig] = Jwt.decode<NintendoAccountSessionTokenJwtPayload>(token);

    if (jwt.payload.iss !== 'https://accounts.nintendo.com') {
        throw new Error('Invalid Nintendo Account session token issuer');
    }
    if (jwt.payload.typ !== 'session_token') {
        throw new Error('Invalid Nintendo Account session token type');
    }
    if (jwt.payload.aud !== ZNCA_CLIENT_ID) {
        throw new Error('Invalid Nintendo Account session token audience');
    }
    if (jwt.payload.exp <= (Date.now() / 1000)) {
        throw new Error('Nintendo Account session token expired');
    }

    // Nintendo Account session tokens use a HMAC SHA256 signature, so we can't verify this is valid

    const existingToken: SavedToken | undefined = await storage.getItem('NsoToken.' + token);

    if (!existingToken || existingToken.expires_at <= Date.now()) {
        console.warn('Authenticating to Nintendo Switch Online app');
        debug('Authenticating to znc with session token');

        const {nso, data} = proxy_url ?
            await ZncProxyApi.createWithSessionToken(proxy_url, token) :
            await ZncApi.createWithSessionToken(token);

        const existingToken: SavedToken = {
            ...data,
            expires_at: Date.now() + (data.credential.expiresIn * 1000),
        };

        await storage.setItem('NsoToken.' + token, existingToken);
        await storage.setItem('NintendoAccountToken.' + data.user.id, token);

        return {nso, data: existingToken};
    }

    debug('Using existing token');
    await storage.setItem('NintendoAccountToken.' + existingToken.user.id, token);

    return {
        nso: proxy_url ?
            new ZncProxyApi(proxy_url, token) :
            new ZncApi(existingToken.credential.accessToken),
        data: existingToken,
    };
}