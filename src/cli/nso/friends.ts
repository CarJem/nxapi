import createDebug from 'debug';
// @ts-expect-error
import Table from 'cli-table/lib/index.js';
import { PresenceState } from '../../api/znc-types.js';
import type { Arguments as ParentArguments } from '../nso.js';
import { ArgumentsCamelCase, Argv, getToken, hrduration, initStorage, YargsArguments } from '../../util.js';

const debug = createDebug('cli:nso:friends');

export const command = 'friends';
export const desc = 'List Nintendo Switch friends';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.option('user', {
        describe: 'Nintendo Account ID',
        type: 'string',
    }).option('token', {
        describe: 'Nintendo Account session token',
        type: 'string',
    }).option('json', {
        describe: 'Output raw JSON',
        type: 'boolean',
    }).option('json-pretty-print', {
        describe: 'Output pretty-printed JSON',
        type: 'boolean',
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    console.warn('Listing friends');

    const storage = await initStorage(argv.dataPath);

    const usernsid = argv.user ?? await storage.getItem('SelectedUser');
    const token: string = argv.token ||
        await storage.getItem('NintendoAccountToken.' + usernsid);
    const {nso, data} = await getToken(storage, token, argv.zncProxyUrl);

    const announcements = await nso.getAnnouncements();
    const friends = await nso.getFriendList();
    const webservices = await nso.getWebServices();
    const activeevent = await nso.getActiveEvent();

    if (argv.jsonPrettyPrint) {
        console.log(JSON.stringify(friends.result.friends, null, 4));
        return;
    }
    if (argv.json) {
        console.log(JSON.stringify(friends.result.friends));
        return;
    }

    const table = new Table({
        head: [
            'ID',
            'NA ID',
            'Name',
            'Status',
            'Favourite?',
            'Added at',
        ],
    });

    for (const friend of friends.result.friends) {
        const online = friend.presence.state === PresenceState.ONLINE ||
            friend.presence.state === PresenceState.PLAYING;

        table.push([
            friend.id,
            friend.nsaId,
            friend.name,
            online ?
                'name' in friend.presence.game ?
                    'Playing ' + friend.presence.game.name + '; played for ' +
                        hrduration(friend.presence.game.totalPlayTime) + ' since ' +
                        new Date(friend.presence.game.firstPlayedAt * 1000).toLocaleDateString('en-GB') :
                    'Online' :
                friend.presence.logoutAt ?
                    'Last seen ' + new Date(friend.presence.logoutAt * 1000).toISOString() :
                    'Offline',
            friend.isFavoriteFriend ? 'Yes' : 'No',
            new Date(friend.friendCreatedAt * 1000).toISOString(),
        ]);
    }

    console.log(table.toString());
}