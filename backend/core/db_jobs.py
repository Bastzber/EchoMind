# -*- coding: utf-8 -*-
"""由 database.py 拆分出来的方法组，不要单独实例化，只作为 DatabaseManager 的 mixin。"""
from __future__ import annotations

from core.db_common import *  # noqa: F401,F403
from core.db_common import (  # noqa: F401
    _execute_sql_statements,
    _get_logger,
    _is_windows_style_path,
    _parse_tags,
    _stable_file_uuid,
)
from core.db_common import logger_proxy as logger  # noqa: F401

# 单例入口在 core.database 里，这里按需延迟取，避免循环导入
def get_db_manager(*args, **kwargs):
    from core.database import get_db_manager as _impl
    return _impl(*args, **kwargs)


def reset_db_manager(*args, **kwargs):
    from core.database import reset_db_manager as _impl
    return _impl(*args, **kwargs)


def init_db(*args, **kwargs):
    from core.database import init_db as _impl
    return _impl(*args, **kwargs)


class JobsMixin:
    def hash_progress(self, project_id: str) -> Dict[str, int]:
        with self.get_cursor() as cursor:
            total = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=?", (str(project_id),)
            ).fetchone()[0]
            done = cursor.execute(
                "SELECT COUNT(*) FROM files WHERE project_id=? AND COALESCE(hash_state,0)>0",
                (str(project_id),),
            ).fetchone()[0]
        return {"total": int(total), "done": int(done)}
    def create_job(self, project_id: str, kind: str, total: int = 0) -> str:
        # 去重：同工程同类型已有排队/running 的任务就直接复用它的 id。
        # 以前每改一次标签就 create_job 一次，改 23 次排 23 个全量修复任务，
        # 界面右上角一直显示「处理中 23」，任务互相抢锁（11-10 实测）。
        try:
            with self.get_cursor() as cursor:
                row = cursor.execute(
                    "SELECT id FROM jobs WHERE project_id=? AND kind=? "
                    "AND state IN ('pending','running') "
                    "ORDER BY created_at DESC LIMIT 1",
                    (str(project_id), str(kind)),
                ).fetchone()
            if row:
                return str(row[0])
        except Exception:
            pass
        job_id = str(uuid.uuid4())
        now = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            cursor.execute("""
                INSERT INTO jobs(id, project_id, kind, state, total, created_at, updated_at)
                VALUES (?, ?, ?, 'pending', ?, ?, ?)
            """, (job_id, project_id, kind, max(0, int(total)), now, now))
        return job_id
    def list_jobs(self, state: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
        """列出后台任务（新的在前）。UI 用它显示「正在跑什么」，看门狗用它找卡死任务。"""
        with self.get_cursor() as cursor:
            if state:
                rows = cursor.execute(
                    "SELECT * FROM jobs WHERE state=? ORDER BY updated_at DESC LIMIT ?",
                    (str(state), max(1, int(limit))),
                ).fetchall()
            else:
                rows = cursor.execute(
                    "SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?",
                    (max(1, int(limit)),),
                ).fetchall()
        return [dict(row) for row in rows]
    def fail_stalled_jobs(self, stale_minutes: float = 10.0) -> List[Dict[str, Any]]:
        """把「running 但长时间没进度」的任务标记为 failed，返回被处理的任务。

        卡死的任务如果一直显示 running，用户会以为软件坏了，也没有重试入口。
        这里按 updated_at 判断：超过阈值没有更新就判失败，并写清楚原因。
        """
        from datetime import datetime as _dt, timedelta as _td

        cutoff = (_dt.now() - _td(minutes=float(stale_minutes))).isoformat()
        stalled: List[Dict[str, Any]] = []
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                "SELECT * FROM jobs WHERE state='running' AND updated_at < ?",
                (cutoff,),
            ).fetchall()
        for row in rows:
            job = dict(row)
            message = (
                f"超过 {int(stale_minutes)} 分钟没有进度更新，判定为卡死并停止跟踪"
                f"（processed={job.get('processed')}/{job.get('total')}，阶段 {job.get('stage') or '-'}）"
            )
            self.update_job(
                job["id"],
                state="failed",
                stage="stalled",
                error_code="job_stalled",
                error_message=message[:400],
            )
            # 任务卡死时不会走到索引流程的 finally，它认领的 processing 工件
            # 就永远没人接手（界面「处理中」数字冻结）。这里替它回滚。
            project_id = job.get("project_id") or "default"
            try:
                with self.get_cursor() as cursor:
                    fixed = cursor.execute(
                        """
                        UPDATE file_artifacts
                        SET state='pending', error_code='job_stalled',
                            error_message='索引任务卡死，已退回待处理', updated_at=?
                        WHERE project_id=? AND state='processing'
                        """,
                        (_dt.now().isoformat(), project_id),
                    ).rowcount
                if fixed:
                    _get_logger().warning(
                        "[Watchdog] 任务 %s 判定卡死，%d 条 processing 退回 pending",
                        job["id"], fixed,
                    )
            except Exception as exc:
                _get_logger().debug("[Watchdog] 回滚 processing 失败: %s", exc)
            job["state"] = "failed"
            job["error_message"] = message
            stalled.append(job)
        return stalled
    def update_job(self, job_id: str, **changes: Any) -> bool:
        allowed = {
            "state", "stage", "processed", "total", "cancel_requested",
            "error_code", "error_message",
        }
        updates = []
        params: List[Any] = []
        for key, value in changes.items():
            if key in allowed:
                updates.append(f"{key}=?")
                params.append(value)
        if not updates:
            return False
        updates.append("updated_at=?")
        params.extend([datetime.now().isoformat(), job_id])
        with self.get_cursor() as cursor:
            cursor.execute(f"UPDATE jobs SET {', '.join(updates)} WHERE id=?", params)
            return cursor.rowcount > 0
    def list_recent_jobs(
        self,
        project_id: Optional[str] = None,
        limit: int = 50,
        states: Optional[Iterable[str]] = None,
    ) -> List[Dict[str, Any]]:
        """最近的任务列表：排查「到底在跑什么」「是不是卡住了」用（B16）。"""
        wanted = [str(s) for s in (states or []) if s]
        sql = "SELECT * FROM jobs"
        clauses: List[str] = []
        params: List[Any] = []
        if project_id:
            clauses.append("project_id=?")
            params.append(str(project_id))
        if wanted:
            clauses.append("state IN (%s)" % ",".join("?" for _ in wanted))
            params.extend(wanted)
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?"
        params.append(max(1, min(int(limit or 50), 500)))
        with self.get_cursor() as cursor:
            rows = cursor.execute(sql, tuple(params)).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["cancel_requested"] = bool(item.get("cancel_requested"))
            result.append(item)
        return result
    def get_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        with self.get_cursor() as cursor:
            row = cursor.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result["cancel_requested"] = bool(result["cancel_requested"])
        return result
    def request_project_job_cancellation(self, project_id: str) -> List[str]:
        """Durably request cancellation before a project deletion takes its lock."""
        now = datetime.now().isoformat()
        with self.get_cursor() as cursor:
            rows = cursor.execute(
                """
                SELECT id FROM jobs
                WHERE project_id=? AND state IN ('pending', 'running')
                """,
                (project_id,),
            ).fetchall()
            job_ids = [str(row["id"]) for row in rows]
            if job_ids:
                cursor.execute(
                    """
                    UPDATE jobs SET cancel_requested=1, updated_at=?
                    WHERE project_id=? AND state IN ('pending', 'running')
                    """,
                    (now, project_id),
                )
        return job_ids
