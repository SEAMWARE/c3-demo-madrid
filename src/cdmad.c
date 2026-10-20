//
// FILE            cdmad.c
//
// Copyright 2026 Seamware
// SPDX-License-Identifier: Apache-2.0
//
// cdmad - the backend of c3-demo-madrid (CDMAD): serves its page, starts and stops the demo's broker, and
// tells c3 where that broker is
//
//   cdmad [--port <port>] [--broker-port <port>] [--coraine <path>] [--www <directory>]
//
//   GET  /c3.json              the descriptor c3 asks for when its broker field says CDMAD: www/c3.json,
//                              "@BROKER@" replaced by the broker's URL
//   GET  /api/broker           {"running", "pid", "url", "uptime", "log"}
//   POST /api/broker/start     starts coraine - a running one is stopped first - and answers once it answers
//   POST /api/broker/stop      stops it: SIGTERM, SIGKILL after 5 s
//   POST /api/refresh          runs tools/snapshot.py --live, answers data/live.json
//   GET  /<file>               a file of www/; /data/<file> one of data/
//
// The broker is the backend's child: in memory (ramDB, its history too), so every start is a clean city,
// and it dies with the backend (PR_SET_PDEATHSIG). Its output goes to $XDG_DATA_HOME/cdmad/broker.log
// (else ~/.local/share/cdmad/broker.log).
//
// A request that waits - a start, a refresh - is suspended and answered by a thread of its own: corHttp
// serves every connection on one thread.
//
// Only for this machine: a connection from another address is refused, and so is a Host that is not
// localhost / 127.0.0.1 / [::1].
//
#define _GNU_SOURCE                              // close_range

#include <arpa/inet.h>                           // ntohl, htons, htonl
#include <errno.h>                               // errno
#include <fcntl.h>                               // open
#include <limits.h>                              // PATH_MAX
#include <netinet/in.h>                          // sockaddr_in, sockaddr_in6
#include <pthread.h>                             // pthread_*
#include <signal.h>                              // signal, kill
#include <stdio.h>                               // printf, fprintf, snprintf
#include <stdlib.h>                              // getenv, malloc, free, realpath
#include <string.h>                              // strcmp, strncmp, strstr, strrchr, strerror
#include <sys/prctl.h>                           // prctl, PR_SET_PDEATHSIG
#include <sys/socket.h>                          // getpeername, socket, connect
#include <sys/stat.h>                            // stat, mkdir
#include <sys/wait.h>                            // waitpid
#include <time.h>                                // time
#include <unistd.h>                              // fork, execv, readlink, usleep, close

#include "corAlloc/corAlloc.h"                   // corAlloc
#include "corArgs/corArgs.h"                     // corArgsInit, corArgsParse
#include "corArgs/CorArg.h"                      // CorArg
#include "corHttp/CorHttp.h"                     // CorHttp*
#include "corRest/corRestClient.h"               // corRestClientMulti*



// -----------------------------------------------------------------------------
//
// Limits
//
#define START_TIMEOUT_S     20                   // the broker answering /version
#define STOP_GRACE_S        5                    // SIGTERM, then SIGKILL
#define REFRESH_TIMEOUT_S   120                  // tools/snapshot.py --live
#define FILE_MAX            (64 * 1024 * 1024)   // the largest file served



// -----------------------------------------------------------------------------
//
// Options
//
static unsigned short  port       = 7990;
static unsigned short  brokerPort = 9026;
static char*           coraineArg = NULL;
static char*           wwwArg     = NULL;

static CorArg options[] =
{
  { "--port",        "-p",  CorArgUShort, &port,       CorArgOpt, _vp 7990, _vp 1, _vp 65535, "TCP port of the backend (this machine only)" },
  { "--broker-port", "-bp", CorArgUShort, &brokerPort, CorArgOpt, _vp 9026, _vp 1, _vp 65535, "TCP port of the broker cdmad starts" },
  { "--coraine",     "-c",  CorArgString, &coraineArg, CorArgOpt, NULL,     NULL,  NULL,      "the coraine binary (default: the one in $PATH)" },
  { "--www",         "-w",  CorArgString, &wwwArg,     CorArgOpt, NULL,     NULL,  NULL,      "directory of the page (default: www/ next to the binary)" },
  CORARGS_END
};



// -----------------------------------------------------------------------------
//
// Globals - the checkout's directories, the broker
//
static char             rootDir[PATH_MAX];       // the checkout: www/, data/, tools/
static char             wwwDir[PATH_MAX + 8];
static char             dataDir[PATH_MAX + 8];
static char             coraine[PATH_MAX];
static char             logPath[PATH_MAX];
static CorHttpServer    server;

static pthread_mutex_t  brokerMutex = PTHREAD_MUTEX_INITIALIZER;   // one start or stop at a time
static pid_t            brokerPid   = 0;
static time_t           brokerStart = 0;



// -----------------------------------------------------------------------------
//
// onSignal -
//
static void onSignal(int sigNo)
{
  (void) sigNo;
  corHttpStop(&server);
}



// -----------------------------------------------------------------------------
//
// jsonEscape - 's' as the inside of a JSON string, allocated from the connection
//
static char* jsonEscape(CorHttpConn* connP, const char* s)
{
  int   len = strlen(s);
  char* out = corAlloc(&connP->alloc, len * 6 + 1);
  int   o   = 0;

  for (; *s != 0; ++s)
  {
    unsigned char c = (unsigned char) *s;

    if ((c == '"') || (c == '\\'))
    {
      out[o++] = '\\';
      out[o++] = c;
    }
    else if (c < 0x20)
      o += sprintf(&out[o], "\\u%04x", c);
    else
      out[o++] = c;
  }

  out[o] = 0;
  return out;
}



// -----------------------------------------------------------------------------
//
// respond - an answer; 'body' must outlive the callback (a literal, or from connP->alloc)
//
static void respond(CorHttpConn* connP, int status, const char* type, const char* body, int len)
{
  corHttpResponseStatus(connP, status);
  corHttpResponseHeader(connP, "Content-Type", type);
  corHttpResponseHeader(connP, "Cache-Control", "no-store");
  corHttpResponseBody(connP, (char*) body, len);
}



// -----------------------------------------------------------------------------
//
// respondJson / respondError -
//
static void respondJson(CorHttpConn* connP, int status, const char* json)
{
  respond(connP, status, "application/json", json, strlen(json));
}

static void respondError(CorHttpConn* connP, int status, const char* title, const char* detail)
{
  const char* t    = jsonEscape(connP, title);
  const char* d    = jsonEscape(connP, detail);
  int         size = strlen(t) + strlen(d) + 64;
  char*       body = corAlloc(&connP->alloc, size);

  snprintf(body, size, "{\"title\": \"%s\", \"detail\": \"%s\"}", t, d);
  respondJson(connP, status, body);
}



// -----------------------------------------------------------------------------
//
// fileRead - a whole file, from the connection's allocator; NULL when it cannot be read
//
static char* fileRead(CorHttpConn* connP, const char* path, int* lenP)
{
  int fd = open(path, O_RDONLY);
  if (fd == -1)
    return NULL;

  struct stat st;
  if ((fstat(fd, &st) == -1) || (!S_ISREG(st.st_mode)) || (st.st_size > FILE_MAX))
  {
    close(fd);
    return NULL;
  }

  char*   buf = corAlloc(&connP->alloc, st.st_size + 1);
  ssize_t got = 0;

  while (got < st.st_size)
  {
    ssize_t n = read(fd, buf + got, st.st_size - got);
    if (n <= 0)
    {
      if ((n == -1) && (errno == EINTR))
        continue;
      break;
    }
    got += n;
  }
  close(fd);

  if (got != st.st_size)
    return NULL;

  buf[got] = 0;
  *lenP    = got;
  return buf;
}



// -----------------------------------------------------------------------------
//
// contentType - by the file's extension
//
static const char* contentType(const char* path)
{
  const char* dot = strrchr(path, '.');

  if (dot == NULL)                    return "application/octet-stream";
  if (strcmp(dot, ".html")  == 0)     return "text/html; charset=utf-8";
  if (strcmp(dot, ".js")    == 0)     return "text/javascript; charset=utf-8";
  if (strcmp(dot, ".mjs")   == 0)     return "text/javascript; charset=utf-8";
  if (strcmp(dot, ".css")   == 0)     return "text/css; charset=utf-8";
  if (strcmp(dot, ".json")  == 0)     return "application/json";
  if (strcmp(dot, ".svg")   == 0)     return "image/svg+xml";
  if (strcmp(dot, ".png")   == 0)     return "image/png";
  if (strcmp(dot, ".woff2") == 0)     return "font/woff2";
  if (strcmp(dot, ".pbf")   == 0)     return "application/x-protobuf";

  return "application/octet-stream";
}



// -----------------------------------------------------------------------------
//
// serveFile - a file of www/, or of data/ (/data/...)
//
static void serveFile(CorHttpConn* connP, const char* path)
{
  if (strcmp(path, "/") == 0)
    path = "/index.html";

  if ((strstr(path, "/.") != NULL) || (strstr(path, "\\") != NULL))   // nothing outside the directory, no hidden files
  {
    respondError(connP, 404, "Not found", path);
    return;
  }

  char file[2 * PATH_MAX];
  if (strncmp(path, "/data/", 6) == 0)
    snprintf(file, sizeof(file), "%s%s", dataDir, &path[5]);
  else
    snprintf(file, sizeof(file), "%s%s", wwwDir, path);

  int   len  = 0;
  char* body = fileRead(connP, file, &len);

  if (body == NULL)
  {
    respondError(connP, 404, "Not found", path);
    return;
  }

  respond(connP, 200, contentType(file), body, len);
}



// -----------------------------------------------------------------------------
//
// serveDescriptor - GET /c3.json: www/c3.json with "@BROKER@" replaced by the broker's URL
//
static void serveDescriptor(CorHttpConn* connP)
{
  char file[PATH_MAX + 16];
  int  len = 0;

  snprintf(file, sizeof(file), "%s/c3.json", wwwDir);

  char* text = fileRead(connP, file, &len);
  if (text == NULL)
  {
    respondError(connP, 404, "Not found", "www/c3.json");
    return;
  }

  char  url[64];
  char* mark = strstr(text, "@BROKER@");

  snprintf(url, sizeof(url), "http://127.0.0.1:%d", brokerPort);

  if (mark == NULL)
  {
    respondJson(connP, 200, text);
    return;
  }

  int   size = len + strlen(url) + 1;
  char* out  = corAlloc(&connP->alloc, size);

  *mark = 0;
  snprintf(out, size, "%s%s%s", text, url, mark + 8);
  respondJson(connP, 200, out);
}



// -----------------------------------------------------------------------------
//
// brokerReap - the broker's process, if it is gone (brokerMutex held)
//
static void brokerReap(void)
{
  if (brokerPid <= 0)
    return;

  int status;
  if (waitpid(brokerPid, &status, WNOHANG) == brokerPid)
  {
    printf("cdmad: the broker (pid %d) is gone - %s %d\n", brokerPid,
           WIFSIGNALED(status) ? "signal" : "exit", WIFSIGNALED(status) ? WTERMSIG(status) : WEXITSTATUS(status));
    fflush(stdout);
    brokerPid = 0;
  }
}



// -----------------------------------------------------------------------------
//
// brokerStop - SIGTERM to its process group, SIGKILL after STOP_GRACE_S (brokerMutex held)
//
static void brokerStop(void)
{
  brokerReap();
  if (brokerPid <= 0)
    return;

  kill(-brokerPid, SIGTERM);

  for (int ix = 0; ix < STOP_GRACE_S * 10; ix++)
  {
    if (waitpid(brokerPid, NULL, WNOHANG) == brokerPid)
    {
      printf("cdmad: the broker (pid %d) stopped\n", brokerPid);
      fflush(stdout);
      brokerPid = 0;
      return;
    }
    usleep(100 * 1000);
  }

  kill(-brokerPid, SIGKILL);
  waitpid(brokerPid, NULL, 0);
  printf("cdmad: the broker (pid %d) killed - it did not stop in %d s\n", brokerPid, STOP_GRACE_S);
  fflush(stdout);
  brokerPid = 0;
}



// -----------------------------------------------------------------------------
//
// brokerAnswers - GET /version answers 200
//
static bool brokerAnswers(void)
{
  char                url[96];
  CorRestClientMulti* multiP = corRestClientMultiCreate(1);
  bool                ok     = false;

  if (multiP == NULL)
    return false;

  snprintf(url, sizeof(url), "http://127.0.0.1:%d/version", brokerPort);
  corRestClientMultiMaxResponse(multiP, 64 * 1024);

  if (corRestClientMultiAdd(multiP, CorVerbGet, url, NULL, 0, NULL, 0, NULL, NULL) >= 0)
  {
    corRestClientMultiPerform(multiP, 1000);

    CorRestClientResponse* respP = corRestClientMultiResponse(multiP, 0);
    ok = (respP != NULL) && (respP->statusCode == 200);
  }

  corRestClientMultiDestroy(multiP);
  return ok;
}



// -----------------------------------------------------------------------------
//
// portBusy - something listens on 127.0.0.1:<p>
//
static bool portBusy(unsigned short p)
{
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd == -1)
    return false;

  struct sockaddr_in sa;
  memset(&sa, 0, sizeof(sa));
  sa.sin_family      = AF_INET;
  sa.sin_port        = htons(p);
  sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

  bool busy = (connect(fd, (struct sockaddr*) &sa, sizeof(sa)) == 0);
  close(fd);

  return busy;
}



// -----------------------------------------------------------------------------
//
// brokerSpawn - starts the broker, a running one stopped first (brokerMutex held); false with why in 'err'
//
// Called on the loop's thread - the main thread, as long-lived as cdmad: PR_SET_PDEATHSIG fires when the
// THREAD that forked the child ends, not the process, and a job thread ends as soon as it has answered.
//
static bool brokerSpawn(char* err, int errLen)
{
  brokerStop();

  if (portBusy(brokerPort))
  {
    snprintf(err, errLen, "port %d is taken by another process - stop it, or start cdmad with --broker-port", brokerPort);
    return false;
  }

  char bridges[PATH_MAX + 32];
  char portText[16];
  struct stat st;

  snprintf(bridges, sizeof(bridges), "%s/bridges.json", dataDir);
  snprintf(portText, sizeof(portText), "%d", brokerPort);

  bool  withBridge = (stat(bridges, &st) == 0);   // no data/bridges.json: the argv ends before --bridges
  char* argv[]     =
  {
    coraine, (char*) "-fg", (char*) "-p", portText, (char*) "-db", (char*) "ramDB", (char*) "--troe", (char*) "ramDB",
    (char*) "--transports", (char*) "ws",
    withBridge ? (char*) "--bridges"     : NULL, (char*) "ckan",
    (char*) "--bridgeConfig", bridges,
    NULL
  };

  int logFd = open(logPath, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (logFd == -1)
  {
    snprintf(err, errLen, "cannot write %s: %s", logPath, strerror(errno));
    return false;
  }

  pid_t pid = fork();
  if (pid == -1)
  {
    snprintf(err, errLen, "fork: %s", strerror(errno));
    close(logFd);
    return false;
  }

  if (pid == 0)                                  // only async-signal-safe calls here: cdmad has threads
  {
    setpgid(0, 0);
    prctl(PR_SET_PDEATHSIG, SIGTERM);            // the broker dies with cdmad

    int null = open("/dev/null", O_RDONLY);
    if (null != -1)
      dup2(null, 0);
    dup2(logFd, 1);
    dup2(logFd, 2);
    close_range(3, ~0U, 0);

    signal(SIGPIPE, SIG_DFL);
    signal(SIGINT,  SIG_DFL);
    signal(SIGTERM, SIG_DFL);

    execv(argv[0], argv);
    _exit(127);
  }

  setpgid(pid, pid);
  close(logFd);

  brokerPid   = pid;
  brokerStart = time(NULL);
  printf("cdmad: broker started, pid %d, port %d%s - log %s\n", pid, brokerPort, withBridge ? ", ckan bridge" : "", logPath);
  fflush(stdout);
  return true;
}



// -----------------------------------------------------------------------------
//
// brokerWaitReady - the broker just spawned answers /version, within START_TIMEOUT_S (brokerMutex held)
//
static bool brokerWaitReady(char* err, int errLen)
{
  for (int ix = 0; ix < START_TIMEOUT_S * 5; ix++)
  {
    if (brokerAnswers())
      return true;

    brokerReap();
    if (brokerPid == 0)
    {
      snprintf(err, errLen, "the broker exited at once - see %s", logPath);
      return false;
    }

    usleep(200 * 1000);
  }

  brokerStop();
  snprintf(err, errLen, "the broker did not answer in %d s - see %s", START_TIMEOUT_S, logPath);
  return false;
}



// -----------------------------------------------------------------------------
//
// brokerState - {"running", "pid", "url", "uptime", "log"}, from the connection's allocator
//
static char* brokerState(CorHttpConn* connP)
{
  char* body = corAlloc(&connP->alloc, PATH_MAX * 7 + 256);

  pthread_mutex_lock(&brokerMutex);
  brokerReap();
  snprintf(body, PATH_MAX * 7 + 256, "{\"running\": %s, \"pid\": %d, \"url\": \"http://127.0.0.1:%d\", \"uptime\": %ld, \"log\": \"%s\"}",
           (brokerPid > 0) ? "true" : "false", brokerPid, brokerPort,
           (brokerPid > 0) ? (long) (time(NULL) - brokerStart) : 0L, jsonEscape(connP, logPath));
  pthread_mutex_unlock(&brokerMutex);

  return body;
}



// -----------------------------------------------------------------------------
//
// refreshRun - tools/snapshot.py --live, at most REFRESH_TIMEOUT_S; false with why in 'err'
//
static bool refreshRun(char* err, int errLen)
{
  char script[PATH_MAX + 32];
  snprintf(script, sizeof(script), "%s/tools/snapshot.py", rootDir);

  char python[] = "/usr/bin/python3";
  char* argv[]  = { python, (char*) "-I", script, (char*) "--live", NULL };

  pid_t pid = fork();
  if (pid == -1)
  {
    snprintf(err, errLen, "fork: %s", strerror(errno));
    return false;
  }

  if (pid == 0)
  {
    setpgid(0, 0);
    if (chdir(rootDir) != 0)
      _exit(126);
    int null = open("/dev/null", O_RDWR);
    if (null != -1)
    {
      dup2(null, 0);
      dup2(null, 1);
    }
    close_range(3, ~0U, 0);
    execv(argv[0], argv);
    _exit(127);
  }

  setpgid(pid, pid);

  for (int ix = 0; ix < REFRESH_TIMEOUT_S * 10; ix++)
  {
    int status;

    if (waitpid(pid, &status, WNOHANG) == pid)
    {
      if (WIFEXITED(status) && (WEXITSTATUS(status) == 0))
        return true;

      snprintf(err, errLen, "tools/snapshot.py --live failed (%s %d) - is the network there?",
               WIFSIGNALED(status) ? "signal" : "exit", WIFSIGNALED(status) ? WTERMSIG(status) : WEXITSTATUS(status));
      return false;
    }
    usleep(100 * 1000);
  }

  kill(-pid, SIGKILL);
  waitpid(pid, NULL, 0);
  snprintf(err, errLen, "tools/snapshot.py --live took more than %d s", REFRESH_TIMEOUT_S);
  return false;
}



// -----------------------------------------------------------------------------
//
// Job - a suspended request and the thread answering it
//
typedef enum JobKind { JobStart, JobRefresh } JobKind;

typedef struct Job
{
  CorHttpConn*  connP;
  JobKind       kind;
} Job;



// -----------------------------------------------------------------------------
//
// jobThread - runs a start or a refresh, answers, resumes the connection
//
static void* jobThread(void* vP)
{
  Job*          jobP  = (Job*) vP;
  CorHttpConn*  connP = jobP->connP;
  char          err[PATH_MAX + 256];

  if (jobP->kind == JobStart)
  {
    pthread_mutex_lock(&brokerMutex);
    bool ok = brokerWaitReady(err, sizeof(err));
    pthread_mutex_unlock(&brokerMutex);

    if (ok)
      respondJson(connP, 200, brokerState(connP));
    else
      respondError(connP, 500, "The broker did not start", err);
  }
  else
  {
    char live[PATH_MAX + 16];
    int  len = 0;

    snprintf(live, sizeof(live), "%s/live.json", dataDir);

    if (refreshRun(err, sizeof(err)) == false)
      respondError(connP, 502, "No refresh", err);
    else
    {
      char* body = fileRead(connP, live, &len);
      if (body == NULL)
        respondError(connP, 500, "No refresh", "tools/snapshot.py --live wrote no data/live.json");
      else
        respond(connP, 200, "application/json", body, len);
    }
  }

  free(jobP);
  corHttpResume(connP);
  return NULL;
}



// -----------------------------------------------------------------------------
//
// jobStart - suspend the request, a detached thread answers it
//
static void jobStart(CorHttpConn* connP, JobKind kind)
{
  Job* jobP = (Job*) malloc(sizeof(Job));
  if (jobP == NULL)
  {
    respondError(connP, 500, "Out of memory", "a job");
    return;
  }

  jobP->connP = connP;
  jobP->kind  = kind;

  if (kind == JobStart)                          // the fork here, on the loop's thread (brokerSpawn); the wait in the job
  {
    char err[PATH_MAX + 256];

    pthread_mutex_lock(&brokerMutex);
    bool ok = brokerSpawn(err, sizeof(err));
    pthread_mutex_unlock(&brokerMutex);

    if (ok == false)
    {
      free(jobP);
      respondError(connP, 500, "The broker did not start", err);
      return;
    }
  }

  pthread_attr_t attr;
  pthread_t      tid;

  corHttpSuspend(connP);
  pthread_attr_init(&attr);
  pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);

  if (pthread_create(&tid, &attr, jobThread, jobP) != 0)
  {
    free(jobP);
    respondError(connP, 500, "No thread", "pthread_create failed");
    corHttpResume(connP);
  }

  pthread_attr_destroy(&attr);
}



// -----------------------------------------------------------------------------
//
// peerIsLocal - the connection comes from this machine
//
static bool peerIsLocal(int fd)
{
  struct sockaddr_storage sa;
  socklen_t               saLen = sizeof(sa);

  if (getpeername(fd, (struct sockaddr*) &sa, &saLen) == -1)
    return false;

  if (sa.ss_family == AF_INET)
    return (ntohl(((struct sockaddr_in*) &sa)->sin_addr.s_addr) >> 24) == 127;

  if (sa.ss_family == AF_INET6)
  {
    struct sockaddr_in6* in6P = (struct sockaddr_in6*) &sa;
    if (IN6_IS_ADDR_LOOPBACK(&in6P->sin6_addr))
      return true;
    if (IN6_IS_ADDR_V4MAPPED(&in6P->sin6_addr))
      return in6P->sin6_addr.s6_addr[12] == 127;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// hostIsLocal - the Host header names this machine, with or without a port
//
static bool hostIsLocal(const char* host)
{
  static const char* names[] = { "localhost", "127.0.0.1", "[::1]" };

  if (host == NULL)
    return false;

  for (unsigned int ix = 0; ix < sizeof(names) / sizeof(names[0]); ix++)
  {
    int len = strlen(names[ix]);

    if ((strncmp(host, names[ix], len) == 0) && ((host[len] == 0) || (host[len] == ':')))
      return true;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// serveRequest - the one corHttp callback
//
static void serveRequest(CorHttpConn* connP)
{
  const char* method = connP->method.s;
  const char* path   = connP->path.s;
  bool        isGet  = (strcmp(method, "GET") == 0);
  bool        isPost = (strcmp(method, "POST") == 0);

  if ((peerIsLocal(connP->fd) == false) || (hostIsLocal(corHttpHeader(connP, "Host")) == false))
  {
    respondError(connP, 403, "Forbidden", "cdmad answers this machine only");
    return;
  }

  if      (isGet  && (strcmp(path, "/c3.json") == 0))           serveDescriptor(connP);
  else if (isGet  && (strcmp(path, "/api/broker") == 0))        respondJson(connP, 200, brokerState(connP));
  else if (isPost && (strcmp(path, "/api/broker/start") == 0))  jobStart(connP, JobStart);
  else if (isPost && (strcmp(path, "/api/refresh") == 0))       jobStart(connP, JobRefresh);
  else if (isPost && (strcmp(path, "/api/broker/stop") == 0))
  {
    pthread_mutex_lock(&brokerMutex);
    brokerStop();
    pthread_mutex_unlock(&brokerMutex);
    respondJson(connP, 200, brokerState(connP));
  }
  else if (strncmp(path, "/api/", 5) == 0)                      respondError(connP, 404, "Not found", path);
  else if (isGet)                                               serveFile(connP, path);
  else                                                          respondError(connP, 405, "Method not allowed", path);
}



// -----------------------------------------------------------------------------
//
// rootResolve - the checkout the binary is in (www/, data/, tools/)
//
static void rootResolve(const char* argv0)
{
  int len = readlink("/proc/self/exe", rootDir, sizeof(rootDir) - 1);

  if (len > 0)
    rootDir[len] = 0;
  else
  {
    char* real = realpath(argv0, NULL);
    snprintf(rootDir, sizeof(rootDir), "%s", (real != NULL) ? real : argv0);
    free(real);
  }

  char* slash = strrchr(rootDir, '/');
  if (slash != NULL)
    *slash = 0;
  else
    snprintf(rootDir, sizeof(rootDir), ".");
}



// -----------------------------------------------------------------------------
//
// coraineResolve - --coraine, else coraine in $PATH
//
static bool coraineResolve(void)
{
  struct stat st;

  if (coraineArg != NULL)
  {
    snprintf(coraine, sizeof(coraine), "%s", coraineArg);
    return (stat(coraine, &st) == 0) && (access(coraine, X_OK) == 0);
  }

  const char* path = getenv("PATH");
  if (path == NULL)
    path = "/usr/local/bin:/usr/bin:/bin";

  while (*path != 0)
  {
    const char* colon = strchr(path, ':');
    int         len   = (colon != NULL) ? (int) (colon - path) : (int) strlen(path);

    snprintf(coraine, sizeof(coraine), "%.*s/coraine", len, path);
    if ((len > 0) && (stat(coraine, &st) == 0) && S_ISREG(st.st_mode) && (access(coraine, X_OK) == 0))
      return true;

    path += len;
    if (*path == ':')
      ++path;
  }

  return false;
}



// -----------------------------------------------------------------------------
//
// logResolve - $XDG_DATA_HOME/cdmad/broker.log, else ~/.local/share/cdmad/broker.log
//
static bool logResolve(void)
{
  const char* xdg  = getenv("XDG_DATA_HOME");
  const char* home = getenv("HOME");
  char        dir[PATH_MAX - 16];

  if ((xdg != NULL) && (xdg[0] == '/'))
    snprintf(dir, sizeof(dir), "%s/cdmad", xdg);
  else if (home != NULL)
  {
    snprintf(dir, sizeof(dir), "%s/.local", home);       mkdir(dir, 0755);
    snprintf(dir, sizeof(dir), "%s/.local/share", home); mkdir(dir, 0755);
    snprintf(dir, sizeof(dir), "%s/.local/share/cdmad", home);
  }
  else
    return false;

  mkdir(dir, 0755);
  snprintf(logPath, sizeof(logPath), "%s/broker.log", dir);
  return true;
}



// -----------------------------------------------------------------------------
//
// main -
//
int main(int argC, char* argV[])
{
  if (corArgsInit("cdmad", options, "CDMAD_") != CorArgsOk)
  {
    fprintf(stderr, "cdmad: corArgsInit failed\n");
    return 1;
  }

  if (corArgsParse(argC, argV) != CorArgsOk)
    return 1;

  rootResolve(argV[0]);
  if (wwwArg != NULL)
    snprintf(wwwDir, sizeof(wwwDir), "%s", wwwArg);
  else
    snprintf(wwwDir, sizeof(wwwDir), "%s/www", rootDir);
  snprintf(dataDir, sizeof(dataDir), "%s/data", rootDir);

  if (coraineResolve() == false)
  {
    fprintf(stderr, "cdmad: no coraine %s - --coraine <path>\n", (coraineArg != NULL) ? coraineArg : "in $PATH");
    return 1;
  }

  if (logResolve() == false)
  {
    fprintf(stderr, "cdmad: no $HOME and no $XDG_DATA_HOME - nowhere for the broker's log\n");
    return 1;
  }

  if (portBusy(port))
  {
    fprintf(stderr, "cdmad: port %d is taken - --port <port>\n", port);
    return 1;
  }

  signal(SIGINT,  onSignal);
  signal(SIGTERM, onSignal);
  signal(SIGPIPE, SIG_IGN);

  corRestClientInit(4, 10, "cdmad");

  if (corHttpInit(&server, port, 64, serveRequest) != CorHttpOk)
  {
    fprintf(stderr, "cdmad: cannot listen on port %d - --port <port>\n", port);
    return 1;
  }

  printf("cdmad - http://localhost:%d/ (this machine only); broker %s on port %d; page %s\n", port, coraine, brokerPort, wwwDir);
  fflush(stdout);

  corHttpServe(&server);

  pthread_mutex_lock(&brokerMutex);
  brokerStop();
  pthread_mutex_unlock(&brokerMutex);
  corHttpRelease(&server);

  printf("cdmad: stopped\n");
  return 0;
}
