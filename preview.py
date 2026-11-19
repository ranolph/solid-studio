"""Entry point for the development preview; production runs server.py directly."""
import os
from pathlib import Path
import runpy
import sys

os.environ.setdefault('HOST', '0.0.0.0')
os.environ.setdefault('PORT', '3000')
os.environ.setdefault('DATA_DIR', str(Path(__file__).resolve().parent.parent / 'qa-solid' / 'preview-data'))
sys.argv = [arg for arg in sys.argv if arg != '--strictPort']
runpy.run_path(str(Path(__file__).with_name('server.py')), run_name='__main__')
