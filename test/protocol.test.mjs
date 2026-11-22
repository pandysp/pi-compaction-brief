import test from 'node:test';
import assert from 'node:assert/strict';
import { verdict, reconcile } from '../eval/protocol.mjs';
const judge=(x,y,preference)=>verdict(JSON.stringify({X:[x],Y:[y],preference,reason:'fixture'}),1).decision;
test('facts override style, without forcing a winner',()=>{
 assert.equal(judge(false,true,'X'),'Y'); assert.equal(judge(false,false,'X'),'both_fail'); assert.equal(judge(true,true,'tie'),'tie');
 assert.throws(()=>verdict('{}',2));
});
test('disagreement across reversed labels is inconclusive',()=>{
 assert.equal(reconcile(['candidate','baseline']),'inconclusive');assert.equal(reconcile(['both_fail','both_fail']),'both_fail');
});
