import { useState, useEffect, useRef } from 'react';

// イージング関数（動きに緩急をつける: 最初は速く、最後はゆっくり）
const easeOutExpo = (t: number): number => {
  return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
};

export const useCountUp = (endValue: number, duration: number = 500) => {
  const [displayValue, setDisplayValue] = useState(endValue);
  const startTimeRef = useRef<number | null>(null);
  const startValueRef = useRef(endValue);
  const requestRef = useRef<number | null>(null);

  useEffect(() => {
    // 値が変わっていなければ何もしない
    if (endValue === displayValue) return;

    startValueRef.current = displayValue; // 現在の表示値をスタート地点にする
    startTimeRef.current = null;
    
    const animate = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      
      const progress = timestamp - startTimeRef.current;
      const percentage = Math.min(progress / duration, 1); // 0.0 〜 1.0
      
      // イージングを適用して、現在の数値を計算
      const ease = easeOutExpo(percentage);
      const nextValue = startValueRef.current + (endValue - startValueRef.current) * ease;
      
      setDisplayValue(nextValue);

      if (percentage < 1) {
        requestRef.current = requestAnimationFrame(animate);
      } else {
        setDisplayValue(endValue); // 念のため最後はきっちり目標値にする
      }
    };

    requestRef.current = requestAnimationFrame(animate);

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [endValue, duration]); // endValueが変わるたびに発火

  return displayValue;
};