'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { pickTargetGroup, rewriteGatewayLines } = require('../scripts/frontend_env');

const GROUP_DATA = [
    '121.46.128.40 vui.oa.fenqile.com',
    '121.46.128.40 cs.fenqile.com/rc_oa_gateway',
    '10.9.24.58 hawkeye.oa.fenqile.com/rc_oa_gateway',
    '10.9.24.58 gateway.oa.fenqile.com/rc_oa_gateway',
    '10.9.24.58 mihawk.oa.fenqile.com/rc_oa_gateway',
    '# 10.9.24.58 mihawk.oa.fenqile.com/groovy-lint',
    '127.0.0.1:8116 mihawk.oa.fenqile.com',
].join('\n');

test('rewriteGatewayLines replaces only mihawk gateway lines and keeps the rest', () => {
    const { value, changes, missing } = rewriteGatewayLines(GROUP_DATA, '10.9.110.229');
    const lines = value.split('\n');
    assert.equal(lines.length, 7);
    assert.equal(lines[1], '121.46.128.40 cs.fenqile.com/rc_oa_gateway');
    assert.equal(lines[2], '10.9.110.229 hawkeye.oa.fenqile.com/rc_oa_gateway');
    assert.equal(lines[4], '10.9.110.229 mihawk.oa.fenqile.com/rc_oa_gateway');
    assert.equal(lines[5], '# 10.9.24.58 mihawk.oa.fenqile.com/groovy-lint');
    assert.equal(lines[6], '127.0.0.1:8116 mihawk.oa.fenqile.com');
    assert.equal(changes.length, 3);
    assert.deepEqual(changes[0], { target: 'hawkeye.oa.fenqile.com/rc_oa_gateway', from: '10.9.24.58' });
    assert.deepEqual(missing, ['mihawk.oa.fenqile.com/groovy-lint']);
});

test('rewriteGatewayLines reports no change when lines already point to the ip', () => {
    const first = rewriteGatewayLines(GROUP_DATA, '10.9.110.229').value;
    const { value, changes } = rewriteGatewayLines(first, '10.9.110.229');
    assert.equal(value, first);
    assert.equal(changes.length, 0);
});

test('pickTargetGroup uses the only enabled group with gateway lines', () => {
    const list = [
        { name: '本地-预发布', selected: false, data: '121.46.128.40 mihawk.oa.fenqile.com/rc_oa_gateway' },
        { name: '本地-项目', selected: true, data: GROUP_DATA },
        { name: 'proxy', selected: true, data: '127.0.0.1:7890 example.com' },
    ];
    assert.equal(pickTargetGroup(list).name, '本地-项目');
    assert.equal(pickTargetGroup(list, '本地-预发布').name, '本地-预发布');
});

test('pickTargetGroup refuses when zero or several enabled groups qualify', () => {
    assert.throws(() => pickTargetGroup([{ name: 'a', selected: false, data: GROUP_DATA }]), /有 0 个/);
    const two = [
        { name: 'a', selected: true, data: GROUP_DATA },
        { name: 'b', selected: true, data: GROUP_DATA },
    ];
    assert.throws(() => pickTargetGroup(two), /有 2 个（a, b）/);
    assert.throws(() => pickTargetGroup(two, 'c'), /没有分组「c」/);
});
