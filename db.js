/* =========================================================
 * 通山打拱 · SQLite 持久化（node:sqlite，Node 24 内置，零依赖）
 * 当前只存「历史分数」，表结构预留后续扩展（players/rounds/plays 需要时再加）。
 * 数据保留策略：每房只留最近 10 场（与旧内存行为一致），超出的自动裁剪。
 * DB 路径：环境变量 DB_PATH 可覆盖；':memory:' 用于测试（不落盘）。
 * ========================================================= */
"use strict";
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

const DB_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DB_DIR, 'tongshan.db');

// ':memory:' 用于测试，跳过建目录
if (DB_PATH !== ':memory:') {
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
}
const db = new DatabaseSync(DB_PATH);

// 建表（幂等）：历史分数一条 = 一场（4 玩家昵称 + 场末累计分）
db.exec(`
  CREATE TABLE IF NOT EXISTS game_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    room_code   TEXT    NOT NULL,
    finished_at INTEGER NOT NULL,
    rounds      INTEGER NOT NULL,
    p1_name TEXT NOT NULL, p1_score INTEGER NOT NULL,
    p2_name TEXT NOT NULL, p2_score INTEGER NOT NULL,
    p3_name TEXT NOT NULL, p3_score INTEGER NOT NULL,
    p4_name TEXT NOT NULL, p4_score INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_history_room ON game_history(room_code, finished_at DESC);
`);

const MAX_KEEP = 10; // 每房只留最近 10 场

const ins = db.prepare(`INSERT INTO game_history
  (room_code, finished_at, rounds, p1_name, p1_score, p2_name, p2_score, p3_name, p3_score, p4_name, p4_score)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const prune = db.prepare(`DELETE FROM game_history WHERE room_code = ? AND id NOT IN (
  SELECT id FROM game_history WHERE room_code = ? ORDER BY finished_at DESC, id DESC LIMIT ?)`);
const sel = db.prepare(`SELECT * FROM game_history WHERE room_code = ? ORDER BY finished_at DESC, id DESC LIMIT ?`);

// 写入一场历史（含裁剪到每房 10 场）。
// rounds 逻辑与旧 pushRoomHistory 一致：提前收场（含局中弃局）按 series.roundCount 记（可为 0），
// 不在此用 settings.rounds 兜底，否则「第一局就提前收场」会把 0 显示成计划局数。
function insertHistory(room) {
  const names = room.seats.map(s => s.name);
  const scores = (room.series.totals || [0, 0, 0, 0]).slice();
  const rounds = Number.isFinite(room.series.roundCount) ? room.series.roundCount : (room.settings.rounds || 1);
  const finishedAt = Date.now();
  ins.run(room.code, finishedAt, rounds,
    names[0], scores[0], names[1], scores[1], names[2], scores[2], names[3], scores[3]);
  prune.run(room.code, room.code, MAX_KEEP);
  return { t: finishedAt, rounds, players: names, scores }; // 返回新记录（旧格式），供调用方更新内存缓存
}

// 读取某房最近 10 场，转回旧内存格式 {t, rounds, players, scores}（客户端/测试零改动）
function getHistory(roomCode) {
  return sel.all(roomCode, MAX_KEEP).map(r => ({
    t: r.finished_at,
    rounds: r.rounds,
    players: [r.p1_name, r.p2_name, r.p3_name, r.p4_name],
    scores:  [r.p1_score, r.p2_score, r.p3_score, r.p4_score],
  }));
}

module.exports = { db, insertHistory, getHistory };
