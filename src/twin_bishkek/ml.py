"""ML: прогноз PM2.5 в Бишкеке на горизонт N часов.

    python -m twin_bishkek.ml train --horizon 24

Что делает: берёт data/processed/hourly.csv (см. data_download.py merge), строит признаки
(погода, календарь, лаги и скользящие средние PM2.5), обучает градиентный бустинг и честно
сравнивает с наивным прогнозом «будет как сейчас». Делит данные ПО ВРЕМЕНИ (последние 20%
в тест), иначе соседние часы утекают между train и test и метрики врут.

Цель: pm25_ground (наземные датчики), если покрытие ≥ 50%, иначе cams_pm2_5 (модель CAMS).
Эта модель потом нужна для калибровки фона и «зимней инверсии» в simulator.P.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score

from .data_download import PROC, ROOT
from .simulator import aqi_from_pm, cat_from_aqi

MODELS = ROOT / "models"
WEATHER = ["temperature_2m", "relative_humidity_2m", "pressure_msl", "precipitation", "wind_speed_10m",
           "wind_direction_10m", "cloud_cover", "boundary_layer_height"]


def pick_target(df: pd.DataFrame) -> str:
    """Наземные датчики, если за период их работы данных достаточно (≥ 50% часов), иначе модель CAMS."""
    if "pm25_ground" in df:
        first = df["pm25_ground"].first_valid_index()
        if first is not None and df.loc[first:, "pm25_ground"].notna().mean() >= 0.5:
            return "pm25_ground"
    return "cams_pm2_5"


def make_features(df: pd.DataFrame, target: str, horizon: int) -> tuple[pd.DataFrame, pd.Series]:
    df = df.sort_index().asfreq("h")
    y_now = df[target].interpolate(limit=6)
    X = pd.DataFrame(index=df.index)
    for c in WEATHER:
        if c in df:
            X[c] = df[c]
    wd = np.deg2rad(df["wind_direction_10m"]) if "wind_direction_10m" in df else 0
    X["wind_u"], X["wind_v"] = -df["wind_speed_10m"] * np.sin(wd), -df["wind_speed_10m"] * np.cos(wd)
    X["dpressure_24h"] = df["pressure_msl"].diff(24)
    X["dtemp_24h"] = df["temperature_2m"].diff(24)
    h, m = df.index.hour, df.index.month
    X["hour_sin"], X["hour_cos"] = np.sin(2 * np.pi * h / 24), np.cos(2 * np.pi * h / 24)
    X["month_sin"], X["month_cos"] = np.sin(2 * np.pi * m / 12), np.cos(2 * np.pi * m / 12)
    X["dow"] = df.index.dayofweek
    X["heating"] = ((m >= 11) | (m <= 3)).astype(int)  # отопительный сезон: уголь в частном секторе
    X["pm_now"] = y_now
    for lag in (1, 3, 6, 12, 24, 48):
        X[f"pm_lag{lag}"] = y_now.shift(lag)
    for win in (24, 72):
        X[f"pm_mean{win}"] = y_now.rolling(win, min_periods=win // 2).mean()
    y = df[target].shift(-horizon)  # цель: значение через horizon часов
    ok = y.notna() & X["pm_now"].notna()
    return X[ok], y[ok]


def _metrics(y, pred) -> dict:
    return dict(
        mae=float(mean_absolute_error(y, pred)),
        rmse=float(np.sqrt(mean_squared_error(y, pred))),
        r2=float(r2_score(y, pred)),
        aqi_category_acc=float((cat_from_aqi(aqi_from_pm(y)) == cat_from_aqi(aqi_from_pm(pred))).mean()),
    )


def train(df: pd.DataFrame, horizon: int = 24, test_frac: float = 0.2, save: bool = True, target: str | None = None) -> dict:
    target = target or pick_target(df)
    if target == "pm25_ground":  # до появления датчиков целевой величины нет: учимся только с первого измерения
        df = df.loc[df["pm25_ground"].first_valid_index():]
    X, y = make_features(df, target, horizon)
    split = int(len(X) * (1 - test_frac))
    Xtr, Xte, ytr, yte = X.iloc[:split], X.iloc[split:], y.iloc[:split], y.iloc[split:]
    # Верхушки загрязнения важнее среднего → модель по логарифму, чтобы не промахиваться в разы в низах
    model = HistGradientBoostingRegressor(max_iter=400, learning_rate=0.05, max_leaf_nodes=24,
                                          l2_regularization=1.0, early_stopping=True, validation_fraction=0.15,
                                          random_state=0)
    model.fit(Xtr, np.log1p(ytr.clip(lower=0)))
    pred = np.expm1(model.predict(Xte)).clip(min=0)
    report = dict(
        target=target, horizon_h=horizon, n_train=len(Xtr), n_test=len(Xte),
        test_period=[str(Xte.index.min()), str(Xte.index.max())],
        model=_metrics(yte, pred),
        persistence=_metrics(yte, Xte["pm_now"]),  # наивный: «как сейчас»
        features=list(X.columns),
    )
    if save:
        MODELS.mkdir(parents=True, exist_ok=True)
        joblib.dump(dict(model=model, features=list(X.columns), target=target, horizon=horizon), MODELS / f"pm25_h{horizon}.joblib")
        (MODELS / f"pm25_h{horizon}_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    return report


def load_model(horizon: int = 24) -> dict:
    return joblib.load(MODELS / f"pm25_h{horizon}.joblib")


def predict(df_recent: pd.DataFrame, horizon: int = 24) -> pd.Series:
    """Прогноз PM2.5 на +horizon ч для каждой строки df_recent (нужно ≥ 72 ч истории подряд)."""
    pack = load_model(horizon)
    X, _ = make_features(df_recent, pack["target"], 0)
    return pd.Series(np.expm1(pack["model"].predict(X[pack["features"]])).clip(min=0), index=X.index + pd.Timedelta(hours=horizon))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["train"])
    ap.add_argument("--horizon", type=int, default=24)
    ap.add_argument("--data", default=str(PROC / "hourly.csv"))
    ap.add_argument("--target", choices=["auto", "ground", "cams"], default="auto",
                    help="на чём учиться: ground = датчики, cams = модель CAMS, auto = выбрать самому")
    a = ap.parse_args()
    df = pd.read_csv(a.data, index_col="time", parse_dates=True)
    forced = {"ground": "pm25_ground", "cams": "cams_pm2_5"}.get(a.target)
    rep = train(df, a.horizon, target=forced)
    m, b = rep["model"], rep["persistence"]
    print(f"цель={rep['target']}  горизонт={a.horizon} ч  train={rep['n_train']}  test={rep['n_test']}")
    print(f"  модель      MAE {m['mae']:.2f}  RMSE {m['rmse']:.2f}  R² {m['r2']:.2f}  категория AQI верна {m['aqi_category_acc']:.0%}")
    print(f"  «как сейчас» MAE {b['mae']:.2f}  RMSE {b['rmse']:.2f}  R² {b['r2']:.2f}  категория AQI верна {b['aqi_category_acc']:.0%}")


if __name__ == "__main__":
    main()
