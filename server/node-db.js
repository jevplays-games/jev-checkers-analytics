/** Thin D1-compatible adapter over Node's built-in SQLite; no production npm dependency. */
import { DatabaseSync } from 'node:sqlite';
export class NodeDB {
  constructor(path=':memory:'){this.db=new DatabaseSync(path);this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');}
  exec(sql){this.db.exec(sql);}
  prepare(sql){return new Statement(this,sql,[]);}
  async batch(statements){
    this.db.exec('BEGIN IMMEDIATE');
    try{const results=statements.map(s=>s._run());this.db.exec('COMMIT');return results;}
    catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}
class Statement {
  constructor(owner,sql,args){this.owner=owner;this.sql=sql;this.args=args;}
  bind(...args){return new Statement(this.owner,this.sql,args.map(x=>x===undefined?null:x));}
  async first(column){const row=this.owner.db.prepare(this.sql).get(...this.args);return column?row?.[column]??null:row?{...row}:null;}
  async all(){return {results:this.owner.db.prepare(this.sql).all(...this.args).map(r=>({...r})),success:true};}
  _run(){const result=this.owner.db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(result.changes),last_row_id:Number(result.lastInsertRowid)}};}
  async run(){return this._run();}
}
