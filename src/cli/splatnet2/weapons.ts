import createDebug from 'debug';
import Table from '../util/table.js';
import type { Arguments as ParentArguments } from '../splatnet2.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../../util/yargs.js';
import { initStorage } from '../../util/storage.js';
import { getIksmToken } from '../../common/auth/splatnet2.js';

const debug = createDebug('cli:splatnet2:weapons');

export const command = 'weapons';
export const desc = 'Show weapon stats';

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
    const storage = await initStorage(argv.dataPath);

    const usernsid = argv.user ?? await storage.getItem('SelectedUser');
    const token: string = argv.token ||
        await storage.getItem('NintendoAccountToken.' + usernsid);
    const {splatnet} = await getIksmToken(storage, token, argv.zncProxyUrl, argv.autoUpdateSession);

    const records = await splatnet.getRecords();

    if (argv.jsonPrettyPrint) {
        console.log(JSON.stringify(records.records.weapon_stats, null, 4));
        return;
    }
    if (argv.json) {
        console.log(JSON.stringify(records.records.weapon_stats));
        return;
    }

    const table = new Table({
        head: [
            'ID',
            'Name',
            'Sub',
            'Special',
            'Wins',
            'Losses',
            'Meter',
            'H. meter',
            'Turf inked',
            'Last used',
        ],
    });

    for (const weaponstats of Object.values(records.records.weapon_stats)) {
        table.push([
            weaponstats.weapon.id,
            weaponstats.weapon.name,
            weaponstats.weapon.sub.name,
            weaponstats.weapon.special.name,
            weaponstats.win_count,
            weaponstats.lose_count,
            weaponstats.win_meter,
            weaponstats.max_win_meter,
            weaponstats.total_paint_point + 'p',
            new Date(weaponstats.last_use_time * 1000).toISOString(),
        ]);
    }

    console.log('Weapon stats');
    console.log(table.toString());
}
