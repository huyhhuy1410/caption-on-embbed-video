# unit test
from app.main import compute_video_time

CASES = [
    (10.0,2.0,True,12.0),
    (10.0,2.0,False,10.5),
    (6.0,0.0,False,4.5),
]

failed = 0
for raw,word_time,first,expected in CASES:
    got = compute_video_time(raw,word_time,first)
    status = "PASS" if got == expected else "FAIL"
    if got != expected:
        failed += 1
    print(f"{status}  raw={raw} word={word_time} first={first} -> {got} (expected {expected})")
    
if failed:
    print(f"FAIL: {failed} test cases failed")
    exit(1)
    
print(f"PASSED: {len(CASES)} test cases passed")

