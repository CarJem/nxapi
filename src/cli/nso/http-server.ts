import createDebug from 'debug';
import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import * as net from 'net';
import persist from 'node-persist';
import { v4 as uuidgen } from 'uuid';
import { ActiveEvent, Announcement, CurrentUser, Friend, Presence, WebService } from '../../api/znc-types.js';
import ZncApi from '../../api/znc.js';
import type { Arguments as ParentArguments } from '../nso.js';
import { ArgumentsCamelCase, Argv, getToken, initStorage, SavedToken, YargsArguments } from '../../util.js';
import { ZncNotifications } from './notify.js';

declare global {
    namespace Express {
        interface Request {
            znc?: ZncApi;
            zncAuth?: SavedToken;

            zncAuthPolicy?: AuthPolicy;
            zncAuthPolicyUser?: string;
            zncAuthPolicyToken?: string;
        }
    }
}

export interface AuthToken {
    user: string;
    policy?: AuthPolicy;
    created_at: number;
}
export interface AuthPolicy {
    announcements?: boolean;
    list_friends?: boolean;
    list_friends_presence?: boolean;
    friend?: boolean;
    friend_presence?: boolean;
    webservices?: boolean;
    activeevent?: boolean;
    current_user?: boolean;
    current_user_presence?: boolean;

    friends?: string[];
    friends_presence?: string[];
}

const debug = createDebug('cli:nso:http-server');

export const command = 'http-server';
export const desc = 'Starts a HTTP server to access the Nintendo Switch Online app API';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.option('listen', {
        describe: 'Server address and port',
        type: 'array',
        default: ['[::]:0'],
    }).option('require-token', {
        describe: 'Require Nintendo Account session token for all requests (if disabled the user query string parameter can be used to use the last token for that user)',
        type: 'boolean',
        default: true,
    }).option('update-interval', {
        describe: 'Max. update interval in seconds',
        type: 'number',
        default: 30,
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const updateInterval = argv.updateInterval * 1000;

    const storage = await initStorage(argv.dataPath);

    const app = express();

    app.use('/api/znc', (req, res, next) => {
        console.log('[%s] %s %s HTTP/%s from %s, port %d%s, %s',
            new Date(), req.method, req.url, req.httpVersion,
            req.socket.remoteAddress, req.socket.remotePort,
            req.headers['x-forwarded-for'] ? ', ' + req.headers['x-forwarded-for'] : '',
            req.headers['user-agent']);

        next();
    });

    const localAuth: express.RequestHandler = async (req, res, next) => {
        if (argv.requireToken || !req.query.user) return next();

        const token = await storage.getItem('NintendoAccountToken.' + req.query.user);
        if (!token) return next();

        req.headers['authorization'] = 'na ' + token;

        next();
    };

    const authToken: express.RequestHandler = async (req, res, next) => {
        if (req.headers['authorization']?.startsWith('Bearer ')) {
            const token = req.headers['authorization'].substr(7);

            const auth: AuthToken | undefined = await storage.getItem('ZncProxyAuthPolicy.' + token);
            if (!auth) return next();

            req.zncAuthPolicy = auth.policy;
            req.zncAuthPolicyUser = auth.user;
            req.zncAuthPolicyToken = token;
        } else if (req.query.token) {
            const auth: AuthToken | undefined = await storage.getItem('ZncProxyAuthPolicy.' + req.query.token);
            if (!auth) return next();

            req.zncAuthPolicy = auth.policy;
            req.zncAuthPolicyUser = auth.user;
            req.zncAuthPolicyToken = '' + req.query.token;
        }

        next();
    };
    function tokenUnauthorised(req: Request, res: Response) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            error: 'token_unauthorised',
        }));
    }

    const nsoAuth: express.RequestHandler = async (req, res, next) => {
        try {
            let nintendoAccountSessionToken: string;
            if (req.zncAuthPolicyUser) {
                const na_token = await storage.getItem('NintendoAccountToken.' + req.zncAuthPolicyUser);
                if (!na_token) throw new Error('Nintendo Account for this token must reauthenticate');
                nintendoAccountSessionToken = na_token;
            } else {
                const auth = req.headers['authorization'];
                if (!auth || !auth.startsWith('na ')) throw new Error('Requires Nintendo Account authentication');
                nintendoAccountSessionToken = auth.substr(3);
            }

            const {nso, data} = await getToken(storage, nintendoAccountSessionToken, argv.zncProxyUrl);

            req.znc = nso;
            req.zncAuth = data;

            const users = new Set(await storage.getItem('NintendoAccountIds') ?? []);
            users.add(data.user.id);
            await storage.setItem('NintendoAccountIds', [...users]);

            next();
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: err,
                error_message: (err as Error).message,
            }));
        }
    };

    app.get('/api/znc/auth', nsoAuth, (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.zncAuth));
    });

    app.get('/api/znc/token', authToken, (req, res) => {
        if (!req.zncAuthPolicyToken) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({error: 'no_policy'}));
            return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.zncAuthPolicy));
    });
    app.delete('/api/znc/token', authToken, async (req, res) => {
        if (!req.zncAuthPolicyToken) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({error: 'no_policy'}));
            return;
        }

        await storage.removeItem('ZncProxyAuthPolicy.' + req.zncAuthPolicyToken!);

        const tokens = new Set(await storage.getItem('ZncProxyAuthPolicies.' + req.zncAuthPolicyUser) ?? []);
        tokens.delete(req.zncAuthPolicyToken);
        await storage.setItem('ZncProxyAuthPolicies.' + req.zncAuthPolicyUser, [...tokens]);

        res.statusCode = 204;
        res.end();
    });
    app.get('/api/znc/tokens', nsoAuth, async (req, res) => {
        const token_ids: string[] | undefined = await storage.getItem('ZncProxyAuthPolicies.' + req.zncAuth!.user.id);
        const tokens = (await Promise.all(token_ids?.map(async id => {
            const auth: AuthToken | undefined = await storage.getItem('ZncProxyAuthPolicy.' + id);
            if (!auth) return;
            return {
                token: id,
                user: auth.user,
                policy: auth.policy,
                created_at: auth.created_at,
            };
        }) ?? [])).filter(p => p);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({tokens}));
    });
    app.post('/api/znc/tokens', nsoAuth, bodyParser.json(), async (req, res) => {
        const token = uuidgen();
        const auth: AuthToken = {
            user: req.zncAuth!.user.id,
            policy: req.body.policy,
            created_at: Math.floor(Date.now() / 1000),
        };

        await storage.setItem('ZncProxyAuthPolicy.' + token, auth);

        const tokens = new Set(await storage.getItem('ZncProxyAuthPolicies.' + req.zncAuth!.user.id) ?? []);
        tokens.add(token);
        await storage.setItem('ZncProxyAuthPolicies.' + req.zncAuth!.user.id, [...tokens]);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            token,
            ...auth,
        }));
    });

    //
    // Announcements
    // This is cached for all users.
    //

    let cached_announcements: Announcement[] | null = null;
    app.get('/api/znc/announcements', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.announcements) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, async (req, res) => {
        if (cached_announcements) {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                announcements: cached_announcements,
            }));
            return;
        }

        try {
            const announcements = await req.znc!.getAnnouncements();
            cached_announcements = announcements.result;

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                announcements: announcements.result,
            }));
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: err,
                error_message: (err as Error).message,
            }));
        }
    });

    //
    // Nintendo Switch friends, NSO app web services, events
    //

    const cached_appdata = new Map<string, [Friend[], WebService[], ActiveEvent, number]>();

    const getAppData: express.RequestHandler = async (req, res, next) => {
        const cache = cached_appdata.get(req.zncAuth!.user.id);

        if (cache && ((cache[3] + updateInterval) > Date.now())) {
            debug('Using cached app data for %s', req.zncAuth!.user.id);
            next();
            return;
        }

        try {
            const friends = await req.znc!.getFriendList();
            const webservices = await req.znc!.getWebServices();
            const activeevent = await req.znc!.getActiveEvent();

            cached_appdata.set(req.zncAuth!.user.id, [
                friends.result.friends, webservices.result, activeevent.result, Date.now(),
            ]);

            next();
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: err,
                error_message: (err as Error).message,
            }));
        }
    };

    app.get('/api/znc/friends', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.list_friends) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            friends: req.zncAuthPolicy?.friends ?
                friends.filter(f => req.zncAuthPolicy!.friends!.includes(f.nsaId)) : friends,
            updated,
        }));
    });

    app.get('/api/znc/friends/presence', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.list_friends_presence) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;
        const presence: Record<string, Presence> = {};

        for (const friend of friends) {
            if (req.zncAuthPolicy) {
                const p = req.zncAuthPolicy;
                if (p.friends_presence && !p.friends_presence.includes(friend.nsaId)) continue;
                if (p.friends && !p.friends_presence && !p.friends.includes(friend.nsaId)) continue;
            }

            presence[friend.nsaId] = friend.presence;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(presence));
    });

    app.get('/api/znc/friend/:nsaid', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.friend) return tokenUnauthorised(req, res);
        if (req.zncAuthPolicy.friends && !req.zncAuthPolicy.friends.includes(req.params.nsaid)) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;
        const friend = friends.find(f => f.nsaId === req.params.nsaid);

        if (!friend) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: 'not_found',
                error_message: 'The user is not friends with the authenticated user.',
            }));
            return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({friend, updated}));
    });

    app.get('/api/znc/friend/:nsaid/presence', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.friend_presence) return tokenUnauthorised(req, res);
        if (req.zncAuthPolicy.friends_presence && !req.zncAuthPolicy.friends_presence.includes(req.params.nsaid)) return tokenUnauthorised(req, res);
        if (req.zncAuthPolicy.friends && !req.zncAuthPolicy.friends_presence && !req.zncAuthPolicy.friends.includes(req.params.nsaid)) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;
        const friend = friends.find(f => f.nsaId === req.params.nsaid);

        if (!friend) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: 'not_found',
                error_message: 'The user is not friends with the authenticated user.',
            }));
            return;
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(friend.presence));
    });

    app.get('/api/znc/webservices', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.webservices) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({webservices, updated}));
    });

    app.get('/api/znc/webservice/:id/token', nsoAuth, async (req, res) => {
        try {
            const response = await req.znc!.getWebServiceToken(req.params.id);

            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                token: response.result,
            }));
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: err,
                error_message: (err as Error).message,
            }));
        }
    });

    app.get('/api/znc/activeevent', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.activeevent) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getAppData, async (req, res) => {
        const [friends, webservices, activeevent, updated] = cached_appdata.get(req.zncAuth!.user.id)!;

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({activeevent, updated}));
    });

    //
    // Nintendo Switch user data
    //

    const cached_userdata = new Map<string, [CurrentUser, number]>();

    const getUserData: express.RequestHandler = async (req, res, next) => {
        const cache = cached_userdata.get(req.zncAuth!.user.id);

        if (cache && ((cache[1] + updateInterval) > Date.now())) {
            debug('Using cached user data for %s', req.zncAuth!.user.id);
            next();
            return;
        }

        try {
            const user = await req.znc!.getCurrentUser();
            cached_userdata.set(req.zncAuth!.user.id, [user.result, Date.now()]);

            next();
        } catch (err) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({
                error: err,
                error_message: (err as Error).message,
            }));
        }
    };

    app.get('/api/znc/user', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.current_user) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getUserData, async (req, res) => {
        const [user, updated] = cached_userdata.get(req.zncAuth!.user.id)!;

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({user, updated}));
    });

    app.get('/api/znc/user/presence', authToken, (req, res, next) => {
        if (!req.zncAuthPolicy) return next();
        if (!req.zncAuthPolicy.current_user_presence) return tokenUnauthorised(req, res);
        if (!('current_user_presence' in req.zncAuthPolicy) && !req.zncAuthPolicy.current_user) return tokenUnauthorised(req, res);
        next();
    }, localAuth, nsoAuth, getUserData, async (req, res) => {
        const [user, updated] = cached_userdata.get(req.zncAuth!.user.id)!;

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(user.presence));
    });

    //
    // Event stream
    //

    app.get('/api/znc/presence/events', localAuth, nsoAuth, async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'text/event-stream');

        const nintendoAccountSessionToken = req.headers['authorization']!.substr(3);
        const i = new ZncPresenceEventStream(
            argv as any, storage, nintendoAccountSessionToken, req.znc!, req.zncAuth!,
            req, res,
            true, true,
        );

        await i.init();

        while (true) {
            await i.loop();
        }
    });

    for (const address of argv.listen) {
        const match = address.match(/^((?:((?:\d+\.){3}\d+)|\[(.*)\]):)(\d+)$/);
        if (!match || (match[1] && !net.isIP(match[2] || match[3]))) throw new Error('Not a valid address/port');

        const server = app.listen(parseInt(match[4]), match[2] || match[3] || '::');
        server.on('listening', () => {
            const address = server.address() as net.AddressInfo;
            console.log('Listening on %s, port %d', address.address, address.port);
        });
    }
}

export enum ZncPresenceEventStreamEvent {
    FRIEND_ONLINE = '0',
    FRIEND_OFFLINE = '1',
    FRIEND_TITLE_CHANGE = '2',
    FRIEND_TITLE_STATECHANGE = '3',
}

class ZncPresenceEventStream extends ZncNotifications {
    constructor(
        argv: ArgumentsCamelCase<Arguments>,
        storage: persist.LocalStorage,
        token: string,
        nso: ZncApi,
        data: Omit<SavedToken, 'expires_at'>,
        public req: express.Request,
        public res: express.Response,
        user: boolean,
        friend: boolean,
    ) {
        super({
            ...argv,
            user: undefined,
            token: undefined,
            'user-notifications': user,
            userNotifications: user,
            'friend-notifications': friend,
            friendNotifications: friend,
            'splatnet2-monitor-directory': undefined,
            splatnet2MonitorDirectory: undefined,
            'splatnet2-monitor-profile-image': false,
            splatnet2MonitorProfileImage: false,
            'splatnet2-monitor-favourite-stage': undefined,
            splatnet2MonitorFavouriteStage: undefined,
            'splatnet2-monitor-favourite-colour': undefined,
            splatnet2MonitorFavouriteColour: undefined,
            'splatnet2-monitor-battles': false,
            splatnet2MonitorBattles: false,
            'splatnet2-monitor-battle-summary-image': false,
            splatnet2MonitorBattleSummaryImage: false,
            'splatnet2-monitor-battle-images': false,
            splatnet2MonitorBattleImages: false,
            'splatnet2-monitor-coop': false,
            splatnet2MonitorCoop: false,
            'splatnet2-monitor-update-interval': 180,
            splatnet2MonitorUpdateInterval: 180,
        }, storage, token, nso, data);
    }

    sendEvent(event: string | null, ...data: unknown[]) {
        if (event) this.res.write('event: ' + event + '\n');
        for (const d of data) this.res.write('data: ' + JSON.stringify(d) + '\n');
        this.res.write('\n');
    }

    onFriendOnline(friend: CurrentUser | Friend, prev?: CurrentUser | Friend, ir?: boolean) {
        this.sendEvent(ZncPresenceEventStreamEvent.FRIEND_ONLINE, {
            id: friend.nsaId, presence: friend.presence, prev: prev?.presence,
        });
    }

    onFriendOffline(friend: CurrentUser | Friend, prev?: CurrentUser | Friend, ir?: boolean) {
        this.sendEvent(ZncPresenceEventStreamEvent.FRIEND_OFFLINE, {
            id: friend.nsaId, presence: friend.presence, prev: prev?.presence,
        });
    }

    onFriendPlayingChangeTitle(friend: CurrentUser | Friend, prev?: CurrentUser | Friend, ir?: boolean) {
        this.sendEvent(ZncPresenceEventStreamEvent.FRIEND_TITLE_CHANGE, {
            id: friend.nsaId, presence: friend.presence, prev: prev?.presence,
        });
    }

    onFriendTitleStateChange(friend: CurrentUser | Friend, prev?: CurrentUser | Friend, ir?: boolean) {
        this.sendEvent(ZncPresenceEventStreamEvent.FRIEND_TITLE_STATECHANGE, {
            id: friend.nsaId, presence: friend.presence, prev: prev?.presence,
        });
    }
}