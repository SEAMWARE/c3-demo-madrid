#
# FILE            makefile
#
# Copyright 2026 Seamware
# SPDX-License-Identifier: Apache-2.0
#
# cdmad - the backend of c3-demo-madrid
#
#   make                 the cdmad binary (in this directory)
#   make run             build, and start cdmad (ARGS="--port 7990")
#   make snapshot        rebuild data/snapshot.json and data/bridges.json from Madrid's sources (network)
#   make clean
#
# Built on the cor-libs, as c3 is: SIBLING checkouts (../corHttp, ../corRest, ...) built there, `-I..`
# and the archives linked by path. COR_LIBS=<dir> for checkouts elsewhere.
#
CC          = gcc
COR_LIBS   ?= ..
BUILD      ?= release

ifeq ($(BUILD),debug)
  OPT       = -g -O0
else
  OPT       = -O2
endif

CFLAGS      = $(OPT) -Wall -Werror -Wundef -Wno-format-truncation -fstack-protector-all -I$(COR_LIBS) -MMD -MP $(EXTRA_CFLAGS)

SOURCES     = src/cdmad.c
OBJDIR      = obj/$(BUILD)
OBJECTS     = $(SOURCES:src/%.c=$(OBJDIR)/%.o)
DEPS        = $(OBJECTS:.o=.d)

#
# Link order: a library before the ones it uses
#
COR_ARCHIVES = $(COR_LIBS)/corHttp/libcorHttp.a   \
               $(COR_LIBS)/corRest/libcorRest.a   \
               $(COR_LIBS)/corJson/libcorJson.a   \
               $(COR_LIBS)/corTree/libcorTree.a   \
               $(COR_LIBS)/corArgs/libcorArgs.a   \
               $(COR_LIBS)/corLog/libcorLog.a     \
               $(COR_LIBS)/corAlloc/libcorAlloc.a \
               $(COR_LIBS)/corBase/libcorBase.a

LIBS        = $(COR_ARCHIVES) -lssl -lcrypto -lz -lpthread -lm

all: cdmad

cdmad: $(OBJECTS) $(COR_ARCHIVES)
	$(CC) -o $@ $(OBJECTS) $(LIBS)

$(OBJDIR)/%.o: src/%.c
	@mkdir -p $(OBJDIR)
	$(CC) $(CFLAGS) -c $< -o $@

$(COR_ARCHIVES):
	@echo "missing $@ - cdmad builds against sibling checkouts of the cor-libs, built there (make in each), or COR_LIBS=<dir>"
	@false

run: cdmad
	./cdmad $(ARGS)

snapshot:
	python3 -I tools/snapshot.py

clean:
	rm -rf obj cdmad

.PHONY: all run snapshot clean

-include $(DEPS)
