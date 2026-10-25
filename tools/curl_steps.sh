# ============================================================================
# XDOJ 流程：一条一条手动跑的命令清单
#
# 用法：把下面「准备」那几行先跑一次，然后按需复制**单独一条**到终端执行。
#       每条命令都是自包含的，不依赖前面的命令留下什么状态。
#
# 目的：找出哪一步会把服务端会话打成 500。
# ============================================================================


# ---------------------------------------------------------------- 准备（跑一次）

# ⚠️ 把这里换成你自己的 OJ 根地址（末尾不要斜杠）
OJ=https://your-oj.example
HOST=${OJ#*://}
BASE=$OJ/xdoj-ssm
ACC=demo-account
SID='<把你的 JSESSIONID 填这里>'
CK="Cookie: JSESSIONID=$SID; preferred_lang=zh_CN"
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36'
JSON='Accept: application/json, text/javascript, */*; q=0.01'
FORM='Content-Type: application/x-www-form-urlencoded; charset=UTF-8'
XRW='X-Requested-With: XMLHttpRequest'


# ---------------------------------------------------------------- 0. 登录
# 用账号密码换一个全新会话；响应头里会打印 Set-Cookie，把 JSESSIONID 抄到上面。

curl -i -s -X POST "$BASE/user/login.do" -H "$FORM" -H "Referer: $OJ/xdoj-ssm/login.jsp" -H "User-Agent: $UA" --data "preferLanguage=zh_CN&userId=$ACC&password=你的密码"


# ---------------------------------------------------------------- 探测命令
# 下面这几条就是「探头」。每跑完一条候选请求，就跑一次探头看状态有没有变。
# A. 比赛题目 —— 就是会 500 的那个

curl -i -s "$BASE/contest/problems.do?contestId=demo-contest&userId=$ACC&_search=false&nd=1&rows=100&page=1&sidx=&sord=asc" -H "$JSON" -H "$XRW" -H "Referer: $OJ/xdoj-ssm/team/problems.do" -H "User-Agent: $UA" -H "$CK"


# B. 比赛列表（POST，jqGrid）—— 扩展开头就打这个

curl -i -s -X POST "$BASE/contest/list.do" -H "$JSON" -H "$XRW" -H "$FORM" -H "Referer: $OJ/xdoj-ssm/team/contests.do" -H "User-Agent: $UA" -H "$CK" --data '_search=false&nd=1&rows=100&page=1&sidx=&sord=asc'


# C. 提交记录（POST，jqGrid）

curl -i -s -X POST "$BASE/submission/results.do?contestId=demo-contest&userId=$ACC" -H "$JSON" -H "$XRW" -H "$FORM" -H "Referer: $OJ/xdoj-ssm/team/results.do" -H "User-Agent: $UA" -H "$CK" --data '_search=false&nd=1&rows=100&page=1&sidx=&sord=asc'


# ---------------------------------------------------------------- 候选「凶手」
# 一条一条试：每跑一条，紧接着跑一次探头 A，看它是不是变 500 了。

# D. 打开比赛列表页面

curl -i -s "$BASE/team/contests.do" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "Referer: $OJ/xdoj-ssm/team/dashboard.do" -H "User-Agent: $UA" -H "$CK"

# E. 打开题目页面

curl -i -s "$BASE/team/problems.do" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "Referer: $OJ/xdoj-ssm/team/contests.do" -H "User-Agent: $UA" -H "$CK"

# F. 打开 dashboard 页面（扩展的题面/诊断都不会碰它，但浏览器会）

curl -i -s "$BASE/team/dashboard.do" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "Referer: $OJ/xdoj-ssm/team/problems.do" -H "User-Agent: $UA" -H "$CK"

# G. dashboard 上的统计接口（浏览器点击图表时会打）

curl -i -s -X POST "$BASE/submission/listUserSubmitStatistics.do" -H "$JSON" -H "$XRW" -H "$FORM" -H "Referer: $OJ/xdoj-ssm/team/dashboard.do" -H "User-Agent: $UA" -H "$CK" --data "userId=$ACC&startDate=2026-01-03&endDate=2026-01-10"

# H. 打开提交页（扩展提交时会 GET 它拿 classId）

curl -i -s "$BASE/team/submit.do?problemId=demo-problem-d" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "Referer: $OJ/xdoj-ssm/team/problems.do" -H "User-Agent: $UA" -H "$CK"

# I. 打开登录页

curl -i -s "$BASE/login.jsp" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "User-Agent: $UA" -H "$CK"

# J. 站点根

curl -i -s "$OJ/xdoj-ssm/" -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' -H 'Accept-Language: zh-CN,zh;q=0.9' -H 'Upgrade-Insecure-Requests: 1' -H "User-Agent: $UA" -H "$CK"


# ---------------------------------------------------------------- 复现「扩展同款」
# 扩展（undici）实际发的是这几个头，curl 不会自动加，手工补上。
# 如果这条必 500 而 D 不会，那问题就在这几个头里。

curl -i -s "$BASE/contest/problems.do?contestId=demo-contest&userId=$ACC&_search=false&nd=1&rows=100&page=1&sidx=&sord=asc" -H "host: $HOST" -H 'connection: keep-alive' -H "$JSON" -H "$XRW" -H 'Accept-Language: zh-CN,zh;q=0.9' -H "User-Agent: $UA" -H "Referer: $OJ/xdoj-ssm/team/problems.do" -H 'sec-fetch-mode: cors' -H 'accept-encoding: gzip, deflate' -H "$CK"


# ---------------------------------------------------------------- 反复探
# 想确认是否稳定，把探头 A 连跑 10 次（间隔 1s）：

for i in $(seq 1 10); do curl -s -o /dev/null -w '%{http_code} ' "$BASE/contest/problems.do?contestId=demo-contest&userId=$ACC&_search=false&nd=1&rows=100&page=1&sidx=&sord=asc" -H "$JSON" -H "$XRW" -H "Referer: $OJ/xdoj-ssm/team/problems.do" -H "User-Agent: $UA" -H "$CK"; sleep 1; done; echo
