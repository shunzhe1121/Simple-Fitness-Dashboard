"""健身记录助手后端包。

模块划分：
    config      配置读取
    utils       日期与数值的通用处理
    db          SQLite 连接与建表
    repository  数据访问层
    nutrition   BMR/TDEE 与宏量营养素计算
    parser      豆包模板文本解析
    agent       LangGraph Agent 与工具集
    api         FastAPI 路由
"""

__all__ = ["config", "utils", "db", "repository", "nutrition", "parser", "api"]
