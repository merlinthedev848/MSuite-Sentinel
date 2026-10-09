from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import declarative_base
from sqlalchemy import event, text
from api.config import settings

DATABASE_URL = settings.database_url

engine_kwargs = {
    "echo": settings.db_echo,
    "pool_pre_ping": True,
}
if DATABASE_URL.startswith("postgresql"):
    engine_kwargs.update(
        pool_size=settings.db_pool_size,
        max_overflow=settings.db_max_overflow,
    )

engine = create_async_engine(DATABASE_URL, **engine_kwargs)

if DATABASE_URL.startswith("sqlite"):
    @event.listens_for(engine.sync_engine, "connect")
    def set_sqlite_pragma(dbapi_connection, connection_record):
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
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

