from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy import event, text
from api.config import settings
from api.db_ready import use_ipv4_loopback

DATABASE_URL = use_ipv4_loopback(settings.database_url)

engine_kwargs = {
    "echo": settings.db_echo,
    "pool_pre_ping": True,
}
if DATABASE_URL.startswith("postgresql"):
    engine_kwargs.update(
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
        pool_recycle=1800,
        # asyncpg otherwise waits forever, and Uvicorn does not open port 8000
        # until startup returns.
        connect_args={"timeout": 10},
    )
elif DATABASE_URL.startswith("sqlite"):
    engine_kwargs.update(
        connect_args={"timeout": 30},
    )

engine = create_async_engine(DATABASE_URL, **engine_kwargs)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine.sync_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.execute("PRAGMA cache_size=-64000")
        cursor.close()

async_session_maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

Base = declarative_base()


# We need to ensure the pgvector extension is created on the postgres database
async def init_vector_db(target_engine):
    async with target_engine.begin() as conn:
        if target_engine.url.get_backend_name().startswith("postgresql"):
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector"))


async def get_db():
    async with async_session_maker() as session:
        yield session
