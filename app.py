"""ResearchBridge entry point; learning-coach service is owned separately."""
import streamlit as st
from screens.home import render

st.set_page_config(page_title='ResearchBridge · Follow your curiosity', page_icon='🌱', layout='wide', initial_sidebar_state='expanded')
render()
